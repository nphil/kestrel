"""Scoring of cached detections against ground truth."""
from __future__ import annotations
import json
import os
from collections import defaultdict
from typing import Dict, Iterable, List, Optional

from . import boxes as B
from . import zones as Z

# NVR's class aliases (ol/al maps in the plugin): everything on the right becomes the class on the left
ALIASES = {
    "vehicle": {"bicycle", "car", "motorcycle", "bus", "train", "truck", "vehicle"},
    "person": {"people", "person"},
    "animal": {"bird", "cat", "dog", "horse", "sheep", "cow", "elephant", "bear", "zebra", "giraffe", "teddy bear",
               "dog_cat", "animal"},
}
_TO_NVR = {n: k for k, v in ALIASES.items() for n in v}


def nvr_class(name) -> Optional[str]:
    """Accepts a class name or a detection dict (uses its 'nvr' field from meta.json when present)."""
    if isinstance(name, dict):
        if name.get("nvr"):
            return name["nvr"]
        name = name["name"]
    return _TO_NVR.get(name)


def matches(det_box, gt_box, min_iou=0.2) -> bool:
    if B.iou(det_box, gt_box) >= min_iou:
        return True
    cx, cy = det_box[0] + det_box[2] / 2, det_box[1] + det_box[3] / 2
    inside = gt_box[0] <= cx <= gt_box[0] + gt_box[2] and gt_box[1] <= cy <= gt_box[1] + gt_box[3]
    return inside and B.area(det_box) <= 6 * B.area(gt_box)


def animal_dets(dets: Iterable[Dict], thr: float, cls_filter="animal") -> List[Dict]:
    out = []
    for d in dets:
        if d["score"] >= thr and nvr_class(d) == cls_filter:
            out.append(d)
    return out


def load_jsonl(path) -> List[Dict]:
    return [json.loads(l) for l in open(path) if l.strip()]


def collect_by_pair(rows: List[Dict]) -> Dict[str, List[Dict]]:
    """rows: detection job results with keys '<pair id>|<suffix>' -> {pair id: [detections in frame px]}"""
    out = defaultdict(list)
    for r in rows:
        pid = r["key"].rsplit("|", 1)[0]
        out[pid].extend(r["dets"])
    return out


def score_pairs(pairs, dets_by_pair: Dict[str, List[Dict]], thr: float, cam_cfg: Optional[Dict] = None,
                zone_filter: bool = False, cls="animal", sizes: Optional[Dict[str, List[int]]] = None):
    """Per-pair outcome list [{pair, kind, tp/fp, ...}] for pairs that have an entry in dets_by_pair."""
    res = []
    for p in pairs:
        if p.id not in dets_by_pair:
            continue
        ds = animal_dets(dets_by_pair[p.id], thr, cls)
        if zone_filter and cam_cfg and p.camera in cam_cfg and sizes and p.id in sizes:
            zs = cam_cfg[p.camera]["detection"]["zones"]
            zs = [z for z in zs if not z.get("observe")]
            ds = [d for d in ds if Z.object_zone_pass(zs, cls, sizes[p.id], d["box"])]
        if p.kind == "neg":
            res.append({"pair": p, "fp": len(ds) > 0, "n": len(ds), "best": max([d["score"] for d in ds], default=0)})
        else:
            hit = any(matches(d["box"], g["box"]) for d in ds for g in p.gt)
            res.append({"pair": p, "hit": hit})
    return res
