#!/usr/bin/env python3
"""Unattended P40 session for the model library, strictly inside the rules (own throwaway container, 4 GB / 4 CPUs, <= 1 GB VRAM,
only when host RAM available >= 10 GB and GPU memory in use < 17000 MiB, never touching production containers):

  phase A  latency + peak VRAM per model, idle-power daemon ACTIVE (continuous + after-2-s-idle calls)     -> bench_p40.json
           models that do not fit the 1 GiB cap get ONE short retry (<= 20 s) with a bigger arena         -> bench_p40_<n>mb.json
  phase B  iNaturalist smoke test for models without a fresh result                                       -> inat_squash.json
  phase C  latency with the daemon PAUSED (`gputune pause`, resumed afterwards, even on errors)            -> bench_p40_paused.json
The container is created at the start and removed at the end (also on errors / Ctrl-C).

usage: run it through capped.sh:  scripts/models/capped.sh .venv/bin/python scripts/models/gpu_pipeline.py [--phases ABC] [--only a,b,c]
Needs the GPU QUIET (util < 30 %, memory < 17000 MiB): it waits otherwise. Whole run ~1.5 h on a quiet card; key models only
(--only mdv6_yolov9c_640,mdv1000_cedar_640,mdv1000_cedar_320,mdv6_yolov10c_640,scrypted_yolov9c_relu_test,yolo11m_coco_640) ~10 min.
"""
import argparse
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))
import bench_p40 as bp  # noqa: E402

BENCH_ORDER = [
    "scrypted_yolov9c_relu_test", "mdv6_yolov9c_640", "mdv1000_cedar_640", "mdv6_yolov9c_320", "mdv6_yolov9c_384", "mdv6_yolov9c_448",
    "mdv6_yolov9c_512", "mdv1000_cedar_320", "mdv1000_cedar_384", "mdv1000_cedar_448", "mdv1000_cedar_512",
    "mdv6_yolov10c_640", "mdv6_yolov10c_640_v8fmt", "mdv6_yolov10c_1280", "mdv1000_sorrel_960", "mdv1000_larch_640",
    "yolo11m_coco_640", "yolo11s_coco_640", "yolov8m_coco_640", "yolov8s_coco_640", "yolov9c_coco_640", "yolov9c_coco_official_640",
    "yoloworld_v8s_640", "yoloworld_v8m_640", "mdv6_rtdetrc_640", "mdv6_rtdetrc_640_v8fmt", "mdv1000_spruce_640",
    "scrypted_yolov9c_relu", "scrypted_yolov9m_relu_test", "scrypted_yolov9m_relu", "scrypted_yolov9s_relu_test", "scrypted_yolov9s_relu",
    "scrypted_yolov9t_relu_test", "scrypted_yolov9t_relu",
    "mdv5a_640", "mdv5a_960", "mdv6_yolov9c_1280", "yolov8m_coco_1280", "mdv5a_1280", "mdv5a_1280_v8fmt", "mdv1000_redwood_1280",
    "mdv6_yolov10e_1280", "mdv6_yolov9e_1280",
]
INAT_ORDER = [
    "mdv6_yolov9c_640", "mdv6_yolov9c_320", "mdv6_yolov9c_448", "mdv6_yolov9c_512", "mdv1000_cedar_640", "scrypted_yolov9c_relu_test",
    "yoloworld_v8s_640", "yoloworld_v8m_640", "mdv6_rtdetrc_640", "mdv6_yolov10c_1280", "yolov9c_coco_official_640", "mdv1000_spruce_640",
    "scrypted_yolov9c_relu", "scrypted_yolov9m_relu_test", "scrypted_yolov9m_relu", "scrypted_yolov9s_relu_test", "scrypted_yolov9s_relu",
    "scrypted_yolov9t_relu_test", "scrypted_yolov9t_relu", "mdv6_yolov9c_1280", "yolov8m_coco_1280", "mdv5a_640", "mdv5a_960",
]


T0 = time.time()
DEADLINE_S = 3 * 3600          # never run longer than 3 h in total, whatever the GPU does


def late() -> bool:
    return time.time() - T0 > DEADLINE_S


def log(msg: str) -> None:
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def container(cmd: str) -> int:
    return subprocess.run([str(HERE / "gpu_container.sh"), cmd]).returncode


def bring_up() -> None:
    while True:
        if late():
            raise SystemExit("gave up waiting for a free GPU / RAM (3 h deadline)")
        rc = container("up")
        if rc == 0:
            return
        log(f"container not started (rc {rc}: RAM < 10 GB or GPU >= 17000 MiB), retrying in 60 s")
        time.sleep(60)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--phases", default="ABC")
    ap.add_argument("--only", default="", help="comma separated model names: restrict all phases to these (quick run in a short quiet-GPU window)")
    a = ap.parse_args()
    if a.only:
        keep = set(a.only.split(","))
        BENCH_ORDER[:] = [n for n in BENCH_ORDER if n in keep]
        INAT_ORDER[:] = [n for n in INAT_ORDER if n in keep]
    try:
        bring_up()
        if "A" in a.phases:
            log("phase A: latency / VRAM, daemon active")
            for n in BENCH_ORDER:
                if late():
                    break
                r = bp.bench(n, 1024, 20.0, False, sporadic=8, tag="", rounds=3)
                if r and r.get("failed") and not (ROOT / "models" / n / "bench_p40_3072mb.json").exists():
                    log(f"{n}: does not fit 1 GiB -> one short run with a 3 GiB arena (<= 20 s per round)")
                    bp.bench(n, 3072, 15.0, False, sporadic=0, tag="", rounds=1)
        if "B" in a.phases:
            log("phase B: iNat smoke test")
            if not late():
                subprocess.run([sys.executable, str(HERE / "inat_sweep.py"), "--force", *INAT_ORDER])
        if "C" in a.phases:
            log("phase C: latency, daemon paused")
            try:
                for n in BENCH_ORDER:
                    if late():
                        break
                    bp.ssh("gputune pause 30")
                    if (ROOT / "models" / n / "bench_p40.json").exists() and (ROOT / "models" / n / "bench_p40.json").read_text().find('"failed": true') >= 0:
                        continue      # did not fit 1 GiB: no paused run
                    bp.bench(n, 1024, 15.0, False, sporadic=0, tag="_paused", rounds=2)
            finally:
                bp.ssh("gputune resume")
        log("pipeline finished")
    finally:
        container("down")
        log("container removed")


if __name__ == "__main__":
    main()
