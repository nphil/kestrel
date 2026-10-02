"""Loads the evaluation pairs (reference frame + test frame + ground truth) from detector-eval/data/."""
from __future__ import annotations
import glob
import json
import os
from dataclasses import dataclass, field
from typing import Dict, List, Optional

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DATA = os.path.join(ROOT, "data")

BUCKETS = [("<32", 0, 32), ("32-64", 32, 64), ("64-128", 64, 128), ("128-256", 128, 256), (">=256", 256, 1e9)]


def bucket_of(px: float) -> str:
    for name, lo, hi in BUCKETS:
        if lo <= px < hi:
            return name
    return ">=256"


@dataclass
class Pair:
    id: str
    kind: str  # neg | comp | real
    camera: str
    ref: Optional[str]
    test: str
    period: str = "day"
    ir: bool = False
    gt: List[Dict] = field(default_factory=list)  # [{box:[x,y,w,h], group, species}]
    tags: List[str] = field(default_factory=list)
    meta: Dict = field(default_factory=dict)

    @property
    def size_px(self) -> Optional[float]:
        return max(self.gt[0]["box"][2], self.gt[0]["box"][3]) if self.gt else None

    @property
    def bucket(self) -> Optional[str]:
        return bucket_of(self.size_px) if self.gt else None


def _jsonl(path):
    if not os.path.exists(path):
        return []
    return [json.loads(l) for l in open(path) if l.strip()]


def load_negatives() -> List[Pair]:
    out = []
    for idx in sorted(glob.glob(os.path.join(DATA, "scenes", "index*.jsonl"))):
        for s in _jsonl(idx):
            d = os.path.join(DATA, "scenes", s["camera"], s["scene_id"])
            if not os.path.isdir(d) or s.get("animal_present"):
                continue
            ref = os.path.join(d, "ref.jpg")
            for fr in s.get("frames", []):
                if fr["file"] == "ref.jpg":
                    continue
                out.append(Pair(id=f"neg/{s['scene_id']}/{fr['file'][:-4]}", kind="neg", camera=s["camera"], ref=ref,
                                test=os.path.join(d, fr["file"]), period=s.get("period", "day"), ir=bool(s.get("ir")),
                                tags=s.get("tags", []), meta={"scene": s["scene_id"], "weather": s.get("weather")}))
    return out


def load_composites() -> List[Pair]:
    out = []
    for c in _jsonl(os.path.join(DATA, "composites", "index.jsonl")):
        out.append(Pair(id=f"comp/{c['id']}", kind="comp", camera=c["camera"], ref=c.get("ref"),
                        test=os.path.join(DATA, "composites", c["id"] + ".jpg"), period=c.get("period", "day"),
                        ir=bool(c.get("ir")), gt=[{"box": c["box"], "group": c.get("group"), "species": c.get("species")}],
                        tags=[c.get("region", "")], meta={k: c.get(k) for k in ("scene", "cutout", "size_bucket", "region")}))
    return out


def load_real_positives() -> List[Pair]:
    """data/positives_real/<id>.jpg + <id>.json (index.jsonl is optional; the .json files are authoritative)."""
    out = []
    d = os.path.join(DATA, "positives_real")
    for jpath in sorted(glob.glob(os.path.join(d, "*.json"))):
        pid = os.path.basename(jpath)[:-5]
        test = os.path.join(d, pid + ".jpg")
        if not os.path.exists(test):
            continue
        info = json.load(open(jpath))
        if not info.get("boxes"):
            continue
        ref = info.get("ref") or None
        if ref and not os.path.isabs(ref):
            ref = os.path.join(ROOT, ref)
        if ref and not os.path.exists(ref):
            ref = None
        out.append(Pair(id=f"real/{pid}", kind="real", camera=str(info["camera"]), ref=ref, test=test,
                        period=info.get("period", "day"), ir=bool(info.get("ir")),
                        gt=[{"box": b["box"], "group": b.get("group"), "species": b.get("species")} for b in info["boxes"]],
                        meta={"source": info.get("source"), "epoch_ms": info.get("epoch_ms")}))
    return out


def load_regress() -> List[Pair]:
    """Person/vehicle regression frames: data/regress/{person,vehicle}/<id>.jpg + .json (boxes carry cls person|vehicle)."""
    out = []
    for jpath in sorted(glob.glob(os.path.join(DATA, "regress", "*", "*.json"))):
        test = jpath[:-5] + ".jpg"
        if not os.path.exists(test):
            continue
        info = json.load(open(jpath))
        if not info.get("boxes"):
            continue
        out.append(Pair(id="reg/" + os.path.basename(os.path.dirname(jpath)) + "/" + os.path.basename(jpath)[:-5], kind="reg",
                        camera=str(info["camera"]), ref=None, test=test, period=info.get("period", "day"), ir=bool(info.get("ir")),
                        gt=[{"box": b["box"], "group": b.get("cls"), "species": None} for b in info["boxes"]]))
    return out


def load_all(kinds=("neg", "comp", "real")) -> List[Pair]:
    pairs: List[Pair] = []
    if "neg" in kinds:
        pairs += load_negatives()
    if "comp" in kinds:
        pairs += load_composites()
    if "real" in kinds:
        pairs += load_real_positives()
    if "reg" in kinds:
        pairs += load_regress()
    return pairs
