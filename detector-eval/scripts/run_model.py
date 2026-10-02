#!/usr/bin/env python3
"""Run any candidate detector from models/<name>/ on a PIL image and get parsed detections back.

    import sys; sys.path.insert(0, "/data/home/Kestrel/detector-eval/scripts")
    from run_model import load, detect
    m = load("scrypted_yolov9c_relu_test")            # onnxruntime, CPU by default
    dets = detect(m, Image.open("frame.jpg"), mode="squash", thr=0.05)
    # [{'cls': 2, 'name': 'animal', 'group': 'animal', 'score': 0.83, 'box': [x, y, w, h]}, ...]

`box` is [x, y, w, h] in pixels of the ORIGINAL image passed in. `group` is animal / person / vehicle / other,
taken from the model's meta.json (animal_classes / person_classes / vehicle_classes).

Preprocessing modes (what is fed to the net):
  squash     image stretched to the net input, aspect ratio NOT kept (what Scrypted's detector plugin does by default)
  letterbox  aspect kept, fitted inside the input, centred, padded with `pad_value` (grey 114 by default,
             what Ultralytics / YOLOv5 training uses; Scrypted's own optional "pad" mode pads with black = 0)

Output decoding follows meta.json["output"]["format"]:
  yolov8_raw      [1, 4+nc, N]  rows 0-3 = x_centre, y_centre, w, h in INPUT pixels, rows 4.. = per-class scores (sigmoid)
  yolov5_raw      [1, N, 5+nc] x_centre, y_centre, w, h in INPUT pixels, objectness, per-class probs; score = obj * cls
  end2end_xyxy    [1, N, 6]    x1, y1, x2, y2 in INPUT pixels, score, class id (NMS already done inside the net)

Options of detect():
  thr          minimum score kept (default 0.05)
  multi_label  True (default): every (anchor, class) pair above `thr` is a candidate, like Scrypted's parse_yolov9;
               False: one candidate per anchor (its best class), like Ultralytics' default predict
  nms_iou      class-aware NMS IoU (default 0.5); None = no NMS (= exactly what Scrypted's plugin does)
  max_det      cap after NMS (default 300)

CLI:  scripts/run_model.py <model-name> <image> [--mode squash|letterbox] [--thr 0.05] [--nms 0.5] [--save out.jpg]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
MODELS_DIR = Path(os.environ.get("DETECTOR_EVAL_MODELS", ROOT / "models"))

_RESAMPLE = {
    "nearest": Image.NEAREST,
    "bilinear": Image.BILINEAR,
    "bicubic": Image.BICUBIC,
    "lanczos": Image.LANCZOS,
    "area": Image.BOX,
}


@dataclass
class Model:
    name: str
    path: Path
    meta: dict
    session: Any
    w: int
    h: int
    fmt: str
    input_name: str
    classes: dict[int, str] = field(default_factory=dict)

    def group_of(self, cls: int) -> str:
        m = self.meta
        if cls in m.get("animal_classes", []):
            return "animal"
        if cls in m.get("person_classes", []):
            return "person"
        if cls in m.get("vehicle_classes", []):
            return "vehicle"
        return "other"


def list_models() -> list[str]:
    return sorted(p.name for p in MODELS_DIR.iterdir() if (p / "model.onnx").exists() and (p / "meta.json").exists())


def load(name: str, providers: list | None = None, threads: int | None = None) -> Model:
    """Load models/<name>/ (or an explicit directory path). providers default: CPU only."""
    import onnxruntime as ort

    p = Path(name)
    if not p.is_dir():
        p = MODELS_DIR / name
    meta = json.loads((p / "meta.json").read_text())
    so = ort.SessionOptions()
    if threads:
        so.intra_op_num_threads = threads
        so.inter_op_num_threads = 1
    sess = ort.InferenceSession(str(p / "model.onnx"), sess_options=so,
                                providers=providers or ["CPUExecutionProvider"])
    inp = sess.get_inputs()[0]
    return Model(name=meta["name"], path=p, meta=meta, session=sess, w=int(meta["input"]["w"]),
                 h=int(meta["input"]["h"]), fmt=meta["output"]["format"], input_name=inp.name,
                 classes={int(k): v for k, v in meta["classes"].items()})


def preprocess(m: Model, img: Image.Image | np.ndarray, mode: str = "squash", pad_value: int | None = None,
               resample: str = "bilinear") -> tuple[np.ndarray, dict]:
    """PIL / HxWx3 uint8 RGB array -> float32 [1,3,H,W] in 0..1 plus the geometry needed to map boxes back."""
    if isinstance(img, np.ndarray):
        img = Image.fromarray(img)
    if img.mode != "RGB":
        img = img.convert("RGB")
    iw, ih = img.size
    W, H = m.w, m.h
    rs = _RESAMPLE[resample]
    if mode == "squash":
        canvas = img.resize((W, H), rs) if (iw, ih) != (W, H) else img
        info = {"sx": W / iw, "sy": H / ih, "dx": 0.0, "dy": 0.0, "iw": iw, "ih": ih}
    elif mode == "letterbox":
        r = min(W / iw, H / ih)
        nw, nh = max(1, round(iw * r)), max(1, round(ih * r))
        pv = m.meta.get("pad_value", 114) if pad_value is None else pad_value
        canvas = Image.new("RGB", (W, H), (pv, pv, pv))
        canvas.paste(img.resize((nw, nh), rs) if (nw, nh) != (iw, ih) else img, ((W - nw) // 2, (H - nh) // 2))
        info = {"sx": nw / iw, "sy": nh / ih, "dx": float((W - nw) // 2), "dy": float((H - nh) // 2), "iw": iw, "ih": ih}
    else:
        raise ValueError(f"mode must be 'squash' or 'letterbox', got {mode!r}")
    x = np.asarray(canvas, dtype=np.uint8).transpose(2, 0, 1)[None].astype(np.float32) / 255.0
    return np.ascontiguousarray(x), info


def infer(m: Model, x: np.ndarray) -> np.ndarray:
    return m.session.run(None, {m.input_name: x})[0]


def _candidates(m: Model, out: np.ndarray, thr: float, multi_label: bool):
    """-> boxes xyxy (input px) [K,4], scores [K], cls [K]"""
    if m.fmt == "yolov8_raw":
        a = out[0]                                    # [4+nc, N]
        xywh, sc = a[:4].T, a[4:].T                   # [N,4], [N,nc]
    elif m.fmt == "yolov5_raw":
        a = out[0]                                    # [N, 5+nc]
        xywh, sc = a[:, :4], a[:, 5:] * a[:, 4:5]
    elif m.fmt == "end2end_xyxy":
        a = out[0]                                    # [N, 6]
        keep = a[:, 4] >= thr
        a = a[keep]
        return a[:, :4].astype(np.float32), a[:, 4].astype(np.float32), a[:, 5].astype(np.int64)
    else:
        raise ValueError(f"unknown output format {m.fmt}")
    if multi_label:
        ai, ci = np.nonzero(sc >= thr)
    else:
        ci_all = sc.argmax(1)
        best = sc[np.arange(sc.shape[0]), ci_all]
        ai = np.nonzero(best >= thr)[0]
        ci = ci_all[ai]
    xywh = xywh[ai]
    xyxy = np.empty_like(xywh)
    xyxy[:, 0] = xywh[:, 0] - xywh[:, 2] / 2
    xyxy[:, 1] = xywh[:, 1] - xywh[:, 3] / 2
    xyxy[:, 2] = xywh[:, 0] + xywh[:, 2] / 2
    xyxy[:, 3] = xywh[:, 1] + xywh[:, 3] / 2
    return xyxy.astype(np.float32), sc[ai, ci].astype(np.float32), ci.astype(np.int64)


def nms(boxes: np.ndarray, scores: np.ndarray, cls: np.ndarray, iou_thr: float) -> np.ndarray:
    """Class-aware greedy NMS; returns kept indices ordered by score."""
    order = np.argsort(-scores, kind="stable")
    keep: list[int] = []
    areas = np.maximum(0, boxes[:, 2] - boxes[:, 0]) * np.maximum(0, boxes[:, 3] - boxes[:, 1])
    alive = np.ones(len(order), dtype=bool)
    ordered = order
    for pos in range(len(ordered)):
        if not alive[pos]:
            continue
        i = ordered[pos]
        keep.append(int(i))
        rest = np.nonzero(alive[pos + 1:])[0] + pos + 1
        if rest.size == 0:
            continue
        j = ordered[rest]
        same = cls[j] == cls[i]
        xx1 = np.maximum(boxes[i, 0], boxes[j, 0])
        yy1 = np.maximum(boxes[i, 1], boxes[j, 1])
        xx2 = np.minimum(boxes[i, 2], boxes[j, 2])
        yy2 = np.minimum(boxes[i, 3], boxes[j, 3])
        inter = np.maximum(0, xx2 - xx1) * np.maximum(0, yy2 - yy1)
        iou = inter / (areas[i] + areas[j] - inter + 1e-9)
        alive[rest[same & (iou > iou_thr)]] = False
    return np.asarray(keep, dtype=np.int64)


def decode(m: Model, out: np.ndarray, info: dict, thr: float = 0.05, multi_label: bool = True,
           nms_iou: float | None = 0.5, max_det: int = 300) -> list[dict]:
    boxes, scores, cls = _candidates(m, out, thr, multi_label)
    if len(scores) == 0:
        return []
    if nms_iou is not None and m.fmt != "end2end_xyxy":
        k = nms(boxes, scores, cls, nms_iou)
    else:
        k = np.argsort(-scores, kind="stable")
    k = k[:max_det]
    boxes, scores, cls = boxes[k], scores[k], cls[k]
    # back to ORIGINAL image pixels
    boxes = boxes.copy()
    boxes[:, [0, 2]] = (boxes[:, [0, 2]] - info["dx"]) / info["sx"]
    boxes[:, [1, 3]] = (boxes[:, [1, 3]] - info["dy"]) / info["sy"]
    boxes[:, [0, 2]] = boxes[:, [0, 2]].clip(0, info["iw"])
    boxes[:, [1, 3]] = boxes[:, [1, 3]].clip(0, info["ih"])
    res = []
    for b, s, c in zip(boxes, scores, cls):
        c = int(c)
        res.append({"cls": c, "name": m.classes.get(c, str(c)), "group": m.group_of(c), "score": float(s),
                    "box": [float(b[0]), float(b[1]), float(b[2] - b[0]), float(b[3] - b[1])]})
    return res


def detect(m: Model, img: Image.Image | np.ndarray, mode: str = "squash", thr: float = 0.05,
           nms_iou: float | None = 0.5, multi_label: bool = True, max_det: int = 300,
           pad_value: int | None = None, resample: str = "bilinear") -> list[dict]:
    x, info = preprocess(m, img, mode, pad_value, resample)
    return decode(m, infer(m, x), info, thr, multi_label, nms_iou, max_det)


def draw(img: Image.Image, dets: list[dict]) -> Image.Image:
    im = img.convert("RGB").copy()
    d = ImageDraw.Draw(im)
    colors = {"animal": (255, 60, 60), "person": (60, 200, 60), "vehicle": (60, 120, 255), "other": (200, 200, 60)}
    lw = max(2, round(max(im.size) / 400))
    for t in dets:
        x, y, w, h = t["box"]
        c = colors[t["group"]]
        d.rectangle([x, y, x + w, y + h], outline=c, width=lw)
        d.text((x + 3, max(0, y - 12)), f'{t["name"]} {t["score"]:.2f}', fill=c)
    return im


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("model", nargs="?", help="model name under models/ (omit to list)")
    ap.add_argument("image", nargs="?")
    ap.add_argument("--mode", default="squash", choices=["squash", "letterbox"])
    ap.add_argument("--thr", type=float, default=0.05)
    ap.add_argument("--nms", type=float, default=0.5, help="NMS IoU, <=0 disables")
    ap.add_argument("--single-label", action="store_true")
    ap.add_argument("--threads", type=int, default=None)
    ap.add_argument("--save", help="write an annotated copy of the image here")
    a = ap.parse_args()
    if not a.model:
        print("\n".join(list_models()))
        return
    m = load(a.model, threads=a.threads)
    img = Image.open(a.image)
    t0 = time.perf_counter()
    dets = detect(m, img, a.mode, a.thr, a.nms if a.nms > 0 else None, not a.single_label)
    dt = (time.perf_counter() - t0) * 1000
    print(f"{m.name}: input {m.w}x{m.h} fmt={m.fmt} image={img.size} mode={a.mode} -> {len(dets)} detections ({dt:.0f} ms incl. preprocess)")
    for t in dets[:40]:
        x, y, w, h = t["box"]
        print(f'  {t["name"]:>12} [{t["group"]}] {t["score"]:.3f}  box x={x:.0f} y={y:.0f} w={w:.0f} h={h:.0f}')
    if a.save:
        draw(img, dets).save(a.save, quality=92)
        print("saved", a.save)


if __name__ == "__main__":
    main()
