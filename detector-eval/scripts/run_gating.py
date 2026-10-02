#!/usr/bin/env python3
"""Computes, for every evaluation pair, what the NVR would hand to the detector (motion boxes -> filters -> crops).
Cached in data/cache/gating/<id>.json. Re-runnable (skips cached pairs unless --force).
  python scripts/run_gating.py --kinds neg,comp,real --workers 3
"""
import argparse
import json
import os
import sys
from multiprocessing import Pool

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(ROOT, "lib"))
import cv2
from evallib import dataset, nvr
from evallib.motion import MotionServer

CACHE_BASE = os.path.join(ROOT, "data", "cache")
CACHE = os.path.join(CACHE_BASE, "gating")
_state = {}


def cache_path(pair_id):
    return os.path.join(_state.get("dir", CACHE), pair_id.replace("/", "__") + ".json")


def work(pair):
    if "srv" not in _state:
        _state["srv"] = MotionServer()
        _state["cfg"] = nvr.load_camera_config()
    srv, cfg = _state["srv"], _state["cfg"]
    out = cache_path(pair.id)
    if os.path.exists(out) and not _state.get("force"):
        return pair.id, "cached"
    if not pair.ref or not os.path.exists(pair.ref):
        return pair.id, "no-ref"
    ref = cv2.cvtColor(cv2.imread(pair.ref), cv2.COLOR_BGR2RGB)
    test = cv2.cvtColor(cv2.imread(pair.test), cv2.COLOR_BGR2RGB)
    if ref.shape != test.shape:
        test = cv2.resize(test, (ref.shape[1], ref.shape[0]))
    mz = ((cfg.get(pair.camera) or {}).get("motion") or {}).get("zones")
    g = nvr.gate(srv, ref, test, motion_zones=mz, variant=_state.get("variant", "stock"))
    g["id"] = pair.id
    g["size"] = [test.shape[1], test.shape[0]]
    json.dump(g, open(out, "w"))
    return pair.id, "ok"


def init(force, variant):
    _state["force"] = force
    tag = variant.split("@")[1] if "@" in variant else ""
    variant = variant.split("@")[0]
    _state["variant"] = variant
    _state["dir"] = os.path.join(CACHE_BASE, "gating_" + tag) if tag else (CACHE if variant == "stock" else os.path.join(CACHE_BASE, "gating_" + variant))
    os.makedirs(_state["dir"], exist_ok=True)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--kinds", default="neg,comp,real")
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--cams", default="")
    ap.add_argument("--tag", default="")
    ap.add_argument("--variant", default="stock", choices=list(nvr.VARIANTS))
    a = ap.parse_args()
    os.makedirs(CACHE, exist_ok=True)
    pairs = dataset.load_all(tuple(a.kinds.split(",")))
    if a.cams:
        pairs = [p for p in pairs if p.camera in a.cams.split(",")]
    if a.limit:
        pairs = pairs[:a.limit]
    print(f"{len(pairs)} pairs", flush=True)
    stats = {}
    with Pool(a.workers, initializer=init, initargs=(a.force, a.variant + ("@" + a.tag if a.tag else ""))) as pool:
        for i, (pid, st) in enumerate(pool.imap_unordered(work, pairs, chunksize=4)):
            stats[st] = stats.get(st, 0) + 1
            if (i + 1) % 100 == 0:
                print(i + 1, stats, flush=True)
    print("done", stats)
