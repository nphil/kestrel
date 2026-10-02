#!/usr/bin/env python3
"""Run the iNaturalist smoke test (inat_gpu_run.py, P40 inside the scrypted container, <= 1 GB) for many models, one after
the other. Skips models that already have a complete result (models/<name>/inat_<mode>.json) unless --force.
Waits (see bench_p40.wait_for_gpu) while the GPU has >= 17000 MiB in use, the host has < 10 GB RAM available or someone else loads the GPU. A model that fails (e.g. does not fit the 1 GB cap) is logged to
models/<name>/inat_error_<mode>.txt and the sweep continues.

usage: inat_sweep.py [--mode squash] [--force] [--mem 1024] name [name ...]
"""
import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


sys.path.insert(0, str(HERE))
from bench_p40 import wait_for_gpu  # noqa: E402  (GPU mem < 17000 MiB, host RAM available >= 10 GB, GPU util < 30 %)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("names", nargs="+")
    ap.add_argument("--mode", default="squash")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--mem", default="1024")
    a = ap.parse_args()
    for n in a.names:
        d = ROOT / "models" / n
        src = ROOT / "data/cache/inat" / f"{n}__{a.mode}.gpu.jsonl"
        if (d / f"inat_{a.mode}.json").exists() and src.exists() and sum(1 for _ in open(src)) >= 1170 and not a.force:
            print(f"{n}: done already", flush=True)
            continue
        wait_for_gpu()
        t0 = time.time()
        r = subprocess.run([sys.executable, str(HERE / "inat_gpu_run.py"), n, a.mode, a.mem], capture_output=True, text=True)
        out = r.stdout.strip().splitlines()
        if r.returncode == 0 and out and out[-1].startswith("{"):
            res = json.loads(out[-1])
            c = res["results"]
            timing = next((l for l in out if l.startswith("timing:")), "")
            print(f"{n}: ok {time.time() - t0:.0f}s  clean birds@.7 {c['clean/Birds']['>=0.7']}  mammals@.7 {c['clean/Mammals']['>=0.7']}  {timing[:200]}", flush=True)
            (d / f"inat_{a.mode}_timing.txt").write_text(timing + "\n")
        else:
            (d / f"inat_error_{a.mode}.txt").write_text((r.stdout[-1500:] + "\n" + r.stderr[-1500:]))
            print(f"{n}: FAILED rc={r.returncode}: {(r.stderr or r.stdout)[-300:]!r}", flush=True)


if __name__ == "__main__":
    main()
