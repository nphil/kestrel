"""The NVR's crop selection (what the detector is shown), ported from the NVR plugin."""
from __future__ import annotations
import json
import os
from typing import Dict, List, Optional

import numpy as np

from . import boxes as B
from . import zones as Z
from .motion import MotionServer, grid_size, motion_boxes

HERE = os.path.dirname(os.path.abspath(__file__))


def load_camera_config(path: Optional[str] = None) -> Dict:
    path = path or os.path.join(HERE, "..", "..", "data", "camera-config.json")
    cfg = json.load(open(path))
    for c in cfg.values():
        for kind in ("detection", "motion"):
            block = c.get(kind)
            if not block:
                continue
            for z in block["zones"]:
                fm = z.get("filterMode")
                z["exclusion"] = fm == "exclude"
                z["observe"] = fm == "observe"
    return cfg


# Variants of the NVR gate used to size what each hard-coded rule costs us (NOT what the live system does):
#   stock    exactly the installed NVR
#   noband   as stock but the top/bottom 10 % of the frame are no longer ignored (what a full-frame motion zone does)
#   nofloor  noband + the "merged motion box must exceed (min(G)/6)^2" size floor lowered to (min(G)/24)^2 and up to 6 crops
VARIANTS = {
    "stock": {"floor_div": 6, "band": True, "max_crops": 3},
    "noband": {"floor_div": 6, "band": False, "max_crops": 3},
    "nofloor": {"floor_div": 24, "band": False, "max_crops": 6},
}


def motion_filter(dets: List[B.Box], dims, motion_zones, grid, floor_div=6, band=True) -> Dict:
    """Z() in the NVR: drop small merged motion boxes, then zone-filter them. Returns kept boxes + diagnostics."""
    W, H = dims
    gmin = min(grid)
    s = gmin / floor_div
    if len(dets) > 1000:
        return {"kept": [[0, 0, W, H]], "excessive": True, "dropped_small": [], "dropped_zone": []}
    bucket = B.Bucketizer(new_t=lambda e: B.area(e), merge_t=lambda e, t, m, a: e + t)
    for t in dets:
        inflated = B.at_least(t, [s, s])

        def merge(existing, t=t, inflated=inflated):
            if B.inter(inflated, existing):
                return B.union(t, existing)
            return None

        bucket.add_box(t, merge)
    r = s * s
    small = []
    for key in list(bucket.boxes.keys()):
        if bucket.boxes[key] <= r:
            small.append(list(key))
            del bucket.boxes[key]
    merged = bucket.keys()
    total = sum(B.area(b) for b in merged)
    excessive = total / (W * H) > 0.8
    zs = [z for z in (motion_zones or []) if not z.get("observe")]
    kept, dropped_zone = [], []
    for b in merged:
        res = Z.evaluate(zs, dims, b)
        if res is None:
            res = Z.intersects(Z.DEFAULT_MOTION_BAND, Z.normalise_box(b, dims)) if band else True
        (kept if res else dropped_zone).append(b)
    return {"kept": kept, "excessive": excessive, "dropped_small": small, "dropped_zone": dropped_zone}


def select_crops(kept: List[B.Box], dims, aspect: float = 1.0, max_crops: int = 3) -> List[B.Box]:
    """Second stage of the NVR: inflate each kept motion box x1.5, merge overlaps, take the 3 largest,
    make them square (clamped to the frame) and return the crop boxes handed to the detector."""
    W, H = dims
    frame = [0, 0, W, H]
    p = B.Bucketizer()
    for e in kept:
        t = B.inter(B.scale(e, 1.5), frame)
        if t:
            p.add_box(t)
    merged = p.keys()
    merged.sort(key=lambda b: -B.area(b))
    crops = B.Bucketizer()
    for e in merged[:max_crops]:
        t = [int(v // 1) for v in e]  # ac(): floor
        i = B.fit_aspect(t, aspect, dims)
        if not i:
            continue
        n = B.inter(frame, B.union(i, t))
        if n:
            crops.add_box(n, lambda existing: None)
    return crops.keys()


def gate(server: MotionServer, ref_rgb: np.ndarray, test_rgb: np.ndarray, motion_zones=None, aspect=1.0,
         variant: str = "stock") -> Dict:
    """Everything the NVR does between two frames and the detector call."""
    v = VARIANTS[variant]
    h, w = test_rgb.shape[:2]
    dets, grid = motion_boxes(server, ref_rgb, test_rgb)
    f = motion_filter(dets, (w, h), motion_zones, grid, floor_div=v["floor_div"], band=v["band"])
    crops = select_crops(f["kept"], (w, h), aspect, max_crops=v["max_crops"])
    return {"motion": dets, "grid": grid, **f, "crops": crops}
