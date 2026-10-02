"""Stand-alone ONNX detector runner (numpy + cv2 + onnxruntime only, so the same file runs in the sandbox on CPU and
inside the scrypted container on the P40).

A model directory holds model.onnx + meta.json (see detector-eval/README in RESULTS.md):
  {"input":{"w":640,"h":640}, "output":{"format":"yolov8_raw|yolov5_raw|end2end_xyxy"}, "classes":{"0":"animal",...}}
Detections come back as dicts {cls, name, score, box:[x,y,w,h]} in ORIGINAL image pixels, after per-class NMS.
"""
from __future__ import annotations
import json
import os
import time
from typing import Dict, List, Optional

import cv2
import numpy as np
import onnxruntime as ort


def _nms(boxes: np.ndarray, scores: np.ndarray, iou_thr: float) -> List[int]:
    """boxes [n,4] x1,y1,x2,y2."""
    if len(boxes) == 0:
        return []
    x1, y1, x2, y2 = boxes.T
    areas = np.maximum(0, x2 - x1) * np.maximum(0, y2 - y1)
    order = scores.argsort()[::-1]
    keep = []
    while order.size:
        i = order[0]
        keep.append(int(i))
        if order.size == 1:
            break
        xx1 = np.maximum(x1[i], x1[order[1:]])
        yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]])
        yy2 = np.minimum(y2[i], y2[order[1:]])
        inter = np.maximum(0, xx2 - xx1) * np.maximum(0, yy2 - yy1)
        iou = inter / (areas[i] + areas[order[1:]] - inter + 1e-9)
        order = order[1:][iou <= iou_thr]
    return keep


class Detector:
    def __init__(self, model_dir: str, provider: str = "cpu", threads: int = 4, gpu_mem_mb: Optional[int] = 1024,
                 meta: Optional[Dict] = None):
        self.dir = model_dir
        self.meta = meta or json.load(open(os.path.join(model_dir, "meta.json")))
        so = ort.SessionOptions()
        if provider == "cpu":
            so.intra_op_num_threads = threads
            providers = ["CPUExecutionProvider"]
        else:
            opts = {"device_id": 0, "arena_extend_strategy": "kSameAsRequested", "cudnn_conv_algo_search": "HEURISTIC"}
            if gpu_mem_mb:
                opts["gpu_mem_limit"] = int(gpu_mem_mb) * 1024 * 1024
            providers = [("CUDAExecutionProvider", opts), "CPUExecutionProvider"]
        self.sess = ort.InferenceSession(os.path.join(model_dir, "model.onnx"), so, providers=providers)
        inp = self.sess.get_inputs()[0]
        self.in_name = inp.name
        self.in_w = int(self.meta["input"]["w"])
        self.in_h = int(self.meta["input"]["h"])
        self.fmt = self.meta["output"]["format"]
        self.classes = {int(k): v for k, v in self.meta["classes"].items()}
        self.nvr_map = {int(k): v for k, v in (self.meta.get("nvr_class") or {}).items()}
        self.last_run_ms = 0.0

    # ---- pre/post -------------------------------------------------------------------------------------------
    def _prep(self, rgb: np.ndarray, mode: str):
        h, w = rgb.shape[:2]
        if mode == "squash":
            interp = cv2.INTER_AREA if (w > self.in_w or h > self.in_h) else cv2.INTER_LINEAR
            im = cv2.resize(rgb, (self.in_w, self.in_h), interpolation=interp)
            tf = (w / self.in_w, h / self.in_h, 0.0, 0.0)  # sx, sy, padx, pady
        else:  # letterbox, keep aspect, pad with 114 like Ultralytics/YOLOv5
            r = min(self.in_w / w, self.in_h / h)
            nw, nh = int(round(w * r)), int(round(h * r))
            interp = cv2.INTER_AREA if r < 1 else cv2.INTER_LINEAR
            im0 = cv2.resize(rgb, (nw, nh), interpolation=interp)
            im = np.full((self.in_h, self.in_w, 3), 114, np.uint8)
            px, py = (self.in_w - nw) // 2, (self.in_h - nh) // 2
            im[py:py + nh, px:px + nw] = im0
            tf = (1 / r, 1 / r, px, py)
        x = im.astype(np.float32).transpose(2, 0, 1)[None] / 255.0
        return np.ascontiguousarray(x), tf

    def _decode(self, out: np.ndarray, thr: float):
        """-> arrays boxes_xyxy [n,4] (input px), scores [n], cls [n]"""
        f = self.fmt
        if f == "yolov8_raw":
            a = out[0]  # [4+nc, N]
            if a.shape[0] > a.shape[1]:
                a = a.T
            xywh, sc = a[:4], a[4:]
            c, n = np.nonzero(sc > thr)
            s = sc[c, n]
            cx, cy, bw, bh = xywh[0, n], xywh[1, n], xywh[2, n], xywh[3, n]
        elif f == "yolov5_raw":
            a = out[0]  # [N, 5+nc]
            obj = a[:, 4:5]
            sc = (a[:, 5:] * obj).T  # [nc, N]
            c, n = np.nonzero(sc > thr)
            s = sc[c, n]
            cx, cy, bw, bh = a[n, 0], a[n, 1], a[n, 2], a[n, 3]
        elif f == "end2end_xyxy":
            a = out[0]  # [N, 6]
            m = a[:, 4] > thr
            a = a[m]
            return a[:, :4].astype(np.float32), a[:, 4], a[:, 5].astype(int)
        else:
            raise ValueError(f)
        b = np.stack([cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2], 1).astype(np.float32)
        return b, s, c

    def detect(self, rgb: np.ndarray, mode: str = "squash", thr: float = 0.05, nms_iou: float = 0.5) -> List[Dict]:
        x, (sx, sy, px, py) = self._prep(rgb, mode)
        t0 = time.perf_counter()
        out = self.sess.run(None, {self.in_name: x})[0]
        self.last_run_ms = (time.perf_counter() - t0) * 1000
        b, s, c = self._decode(out, thr)
        res = []
        for cls in np.unique(c):
            m = c == cls
            idx = _nms(b[m], s[m], nms_iou)
            bm, sm = b[m][idx], s[m][idx]
            for bb, ss in zip(bm, sm):
                x1 = (bb[0] - px) * sx
                y1 = (bb[1] - py) * sy
                x2 = (bb[2] - px) * sx
                y2 = (bb[3] - py) * sy
                res.append({"cls": int(cls), "name": self.classes.get(int(cls), str(cls)), "nvr": self.nvr_map.get(int(cls)),
                            "score": float(ss), "box": [float(x1), float(y1), float(x2 - x1), float(y2 - y1)]})
        res.sort(key=lambda d: -d["score"])
        return res
