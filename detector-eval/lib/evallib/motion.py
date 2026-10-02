"""The NVR's motion stage, run for real: its own release.wasm (via lib/motion_server.mjs) + a port of its post-processing."""
from __future__ import annotations
import json
import math
import os
import subprocess
import tempfile
from typing import List, Optional, Tuple

import cv2
import numpy as np

from . import boxes as B

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(HERE, "..", "motion_server.mjs")


def grid_size(w: int, h: int) -> Tuple[int, int]:
    """G in the NVR: halve the frame while both sides stay >= 270."""
    n, s = w, h
    while n / 2 >= 270 and s / 2 >= 270:
        n /= 2
        s /= 2
    return math.floor(n), math.floor(s)


class MotionServer:
    def __init__(self):
        self.p = subprocess.Popen(["node", "--disable-wasm-trap-handler", SERVER], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
                                  cwd=os.path.join(HERE, "..", ".."))
        self.tmp = tempfile.mkdtemp(prefix="motion-")

    def _call(self, o):
        self.p.stdin.write(json.dumps(o) + "\n")
        self.p.stdin.flush()
        r = json.loads(self.p.stdout.readline())
        if "error" in r:
            raise RuntimeError(r["error"])
        return r

    def regions(self, ref_rgb: np.ndarray, test_rgb: np.ndarray, blur=2, threshold=25):
        h, w = ref_rgb.shape[:2]
        a = os.path.join(self.tmp, "ref.rgb")
        b = os.path.join(self.tmp, "test.rgb")
        ref_rgb.tofile(a)
        test_rgb.tofile(b)
        self._call({"op": "reset"})
        self._call({"op": "frame", "raw": a, "w": w, "h": h, "blur": blur, "threshold": threshold, "update": True})
        return self._call({"op": "frame", "raw": b, "w": w, "h": h, "blur": blur, "threshold": threshold,
                           "update": False})["regions"]

    def close(self):
        try:
            self.p.stdin.close()
            self.p.terminate()
        except Exception:
            pass


def resize_rgb(img_rgb: np.ndarray, gw: int, gh: int) -> np.ndarray:
    h, w = img_rgb.shape[:2]
    if (w, h) == (gw, gh):
        return np.ascontiguousarray(img_rgb)
    return np.ascontiguousarray(cv2.resize(img_rgb, (gw, gh), interpolation=cv2.INTER_AREA))


def postprocess(regions, full_wh, scale_xy, dilate=32, min_area=1) -> List[B.Box]:
    """motion-fork f(): grid regions -> full-res boxes, merged within `dilate` px, area >= min_area."""
    xs, ys = scale_xy
    boxes = []
    for r in regions:
        b = [r["minx"], r["miny"], r["maxx"] - r["minx"] + 1, r["maxy"] - r["miny"] + 1]
        boxes.append([b[0] * xs, b[1] * ys, b[2] * xs, b[3] * ys])
    if dilate == 0:
        return boxes
    bucket = B.Bucketizer()
    for t in boxes:
        inflated = B.at_least(t, [dilate, dilate])

        def merge(existing, t=t, inflated=inflated):
            if B.inter(inflated, existing):
                return B.union(t, existing)
            return None

        bucket.add_box(t, merge)
    return [b for b in bucket.keys() if B.area(b) >= min_area]


def motion_boxes(server: MotionServer, ref_rgb: np.ndarray, test_rgb: np.ndarray, blur=2, threshold=25,
                 dilate=32, min_area=1):
    """Full-resolution motion boxes between a reference frame and a test frame (as the NVR object pipeline sees them)."""
    h, w = test_rgb.shape[:2]
    gw, gh = grid_size(w, h)
    ref_g = resize_rgb(ref_rgb, gw, gh)
    test_g = resize_rgb(test_rgb, gw, gh)
    regs = server.regions(ref_g, test_g, blur=blur, threshold=threshold)
    return postprocess(regs, (w, h), (w / gw, h / gh), dilate=dilate, min_area=min_area), (gw, gh)
