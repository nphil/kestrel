#!/usr/bin/env python3
"""CPU timing of models/<name>/model.onnx with onnxruntime-CPU (default 6 threads, batch 1, real frame squashed to the
model size). The sandbox shares 16 cores with a lot of other work (load average 20-45), so numbers are pessimistic and
noisy: both median and min are stored together with the load average seen.

usage: nice -n 10 bench_cpu.py [--threads 6] [--force] name [name ...]   -> models/<name>/bench_cpu.json
"""
from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
MODELS = ROOT / "models"
IMG = ROOT / "data/truth/raccoon_snap.jpg"


def bench(name: str, threads: int, force: bool) -> dict:
    d = MODELS / name
    out = d / "bench_cpu.json"
    if out.exists() and not force:
        return json.loads(out.read_text())
    meta = json.loads((d / "meta.json").read_text())
    w, h = meta["input"]["w"], meta["input"]["h"]
    x = np.asarray(Image.open(IMG).convert("RGB").resize((w, h), Image.BILINEAR), dtype=np.uint8)
    x = np.ascontiguousarray(x.transpose(2, 0, 1)[None].astype(np.float32) / 255.0)
    so = ort.SessionOptions()
    so.intra_op_num_threads = threads
    so.inter_op_num_threads = 1
    sess = ort.InferenceSession(str(d / "model.onnx"), so, providers=["CPUExecutionProvider"])
    iname = sess.get_inputs()[0].name
    g = meta.get("gflops", 50)
    n = 20 if g < 30 else 10 if g < 120 else 5
    load0 = os.getloadavg()[0]
    sess.run(None, {iname: x})
    sess.run(None, {iname: x})
    ms = []
    for _ in range(n):
        t = time.perf_counter()
        sess.run(None, {iname: x})
        ms.append((time.perf_counter() - t) * 1000)
    res = {"model": name, "threads": threads, "n": n, "median_ms": round(statistics.median(ms), 1), "min_ms": round(min(ms), 1),
           "mean_ms": round(statistics.fmean(ms), 1), "max_ms": round(max(ms), 1), "load_avg_before": round(load0, 1),
           "load_avg_after": round(os.getloadavg()[0], 1), "cores": os.cpu_count(), "ort": ort.__version__}
    out.write_text(json.dumps(res, indent=2) + "\n")
    return res


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("names", nargs="+")
    ap.add_argument("--threads", type=int, default=6)
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    for n in a.names:
        r = bench(n, a.threads, a.force)
        print(f"{n:32s} CPU {a.threads} thr: median {r['median_ms']} ms  min {r['min_ms']} ms  (n={r['n']}, load {r['load_avg_before']}->{r['load_avg_after']})", flush=True)


if __name__ == "__main__":
    main()
