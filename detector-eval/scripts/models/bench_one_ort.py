#!/usr/bin/env python3
"""In-container worker for bench_p40.py: time ONE onnx model on the P40 with onnxruntime-gpu.

Runs with the Python of the scrypted container (onnxruntime-gpu 1.22, numpy; nothing else needed):
  PYTHONPATH=<onnx plugin python3.12 dir> /usr/bin/python3.12 /tmp/bench_one_ort.py --model ... --rand a.npy --real b.npy

Session = CUDAExecutionProvider only (+CPU fallback for tiny unsupported ops) with
  gpu_mem_limit 1 GiB (or --mem-limit-mb), arena kSameAsRequested, cudnn_conv_algo_search HEURISTIC  (shared GPU!)
Batch 1. Warm-up >= --warmup calls AND >= --min-warm-s seconds (GPU clocks are parked at idle), then --iters timed
calls (plain session.run, i.e. includes host<->device copies like the Scrypted plugin) for a random tensor and for the
real-image tensor. Saves the first output of each to --out-prefix{rand,real}.npy so the driver can compare with CPU.
With --sporadic N additionally N real-image calls spaced --gap-s seconds apart (production-like timing).
Prints one line "RESULT {json}" on stdout.
"""
import argparse
import json
import os
import time

import numpy as np
import onnxruntime as ort


def stats(ms):
    a = np.asarray(ms)
    return {"n": int(a.size), "mean_ms": round(float(a.mean()), 3), "median_ms": round(float(np.median(a)), 3),
            "p95_ms": round(float(np.percentile(a, 95)), 3), "min_ms": round(float(a.min()), 3),
            "max_ms": round(float(a.max()), 3)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--rand", required=True)
    ap.add_argument("--real", required=True)
    ap.add_argument("--mem-limit-mb", type=int, default=1024)
    ap.add_argument("--iters", type=int, default=100)
    ap.add_argument("--rounds", type=int, default=3, help="timed rounds of --iters calls; the quietest round is reported")
    ap.add_argument("--warmup", type=int, default=10)
    ap.add_argument("--min-warm-s", type=float, default=2.0)
    ap.add_argument("--max-seconds", type=float, default=0, help="stop timing loops after this many seconds (0=off)")
    ap.add_argument("--out-prefix", default="/tmp/bm/out_")
    ap.add_argument("--sporadic", type=int, default=0, help="extra calls spaced --gap-s apart (production-like: the idle-power daemon parks the GPU between them)")
    ap.add_argument("--gap-s", type=float, default=2.0)
    a = ap.parse_args()

    so = ort.SessionOptions()
    so.log_severity_level = 2
    so.intra_op_num_threads = 2     # explicit count: silences the thread-affinity warnings inside the container
    prov = [("CUDAExecutionProvider", {
        "device_id": 0, "gpu_mem_limit": a.mem_limit_mb << 20, "arena_extend_strategy": "kSameAsRequested",
        "cudnn_conv_algo_search": "HEURISTIC"}), "CPUExecutionProvider"]
    t0 = time.perf_counter()
    sess = ort.InferenceSession(a.model, sess_options=so, providers=prov)
    load_s = time.perf_counter() - t0
    name = sess.get_inputs()[0].name
    res = {"pid": os.getpid(), "providers": sess.get_providers(), "ort": ort.__version__,
           "load_s": round(load_s, 2), "mem_limit_mb": a.mem_limit_mb}
    print("READY", os.getpid(), flush=True)

    for tag in ("rand", "real"):
        x = np.load(getattr(a, tag))
        # warm-up
        t_end = time.perf_counter() + a.min_warm_s
        n = 0
        while n < a.warmup or time.perf_counter() < t_end:
            out = sess.run(None, {name: x})
            n += 1
        np.save(f"{a.out_prefix}{tag}.npy", out[0])
        rounds = []
        for _r in range(a.rounds):      # the card is shared: keep the quietest of several rounds, report all medians
            ms = []
            t_loop = time.perf_counter()
            for _ in range(a.iters):
                t = time.perf_counter()
                sess.run(None, {name: x})
                ms.append((time.perf_counter() - t) * 1000.0)
                if a.max_seconds and time.perf_counter() - t_loop > a.max_seconds:
                    break
            rounds.append(stats(ms))
        best = min(rounds, key=lambda r: r["median_ms"])
        res[tag] = dict(best)
        res[tag]["warmup_calls"] = n
        res[tag]["round_medians_ms"] = [r["median_ms"] for r in rounds]
        res["out_shape"] = list(out[0].shape)
    if a.sporadic:
        ms = []
        for _ in range(a.sporadic):
            time.sleep(a.gap_s)
            t = time.perf_counter()
            sess.run(None, {name: x})
            ms.append((time.perf_counter() - t) * 1000.0)
        res["sporadic"] = stats(ms)
        res["sporadic"]["gap_s"] = a.gap_s
    print("RESULT " + json.dumps(res), flush=True)


if __name__ == "__main__":
    main()
