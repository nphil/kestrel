#!/usr/bin/env python3
"""Runs one detector over a jobs file. Meant to run INSIDE the scrypted container (onnxruntime-gpu, P40) but also
works on CPU:  python gpu_batch_detect.py <model_dir> <jobs.jsonl> <out.jsonl> [--cpu]

jobs.jsonl lines: {"key": str, "image": path, "crop": [x,y,w,h] | null, "mode": "squash"|"letterbox"}
out.jsonl lines:  {"key", "crop":[x,y,w,h], "dets":[{cls,name,score,box[x,y,w,h] in FRAME px}], "ms": <ORT run ms>}
Prints timing + peak VRAM of this process at the end. VRAM cap via env GPU_MEM_MB (default 1024).
"""
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib"))
sys.path.insert(0, "/tmp/de/lib")
import cv2
import numpy as np
from evallib.detect import Detector


def vram_mb():
    try:
        out = subprocess.run(["nvidia-smi", "--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"],
                             capture_output=True, text=True, timeout=10).stdout
        for line in out.strip().splitlines():
            pid, mem = [x.strip() for x in line.split(",")]
            if int(pid) == os.getpid():
                return int(mem)
    except Exception:
        pass
    return None


def main():
    model_dir, jobs_path, out_path = sys.argv[1:4]
    cpu = "--cpu" in sys.argv
    mem = int(os.environ.get("GPU_MEM_MB", "1024"))
    det = Detector(model_dir, provider="cpu" if cpu else "gpu", gpu_mem_mb=mem,
                   threads=int(os.environ.get("THREADS", "4")))
    # warm-up
    dummy = np.random.randint(0, 255, (det.in_h, det.in_w, 3), dtype=np.uint8)
    for _ in range(10):
        det.detect(dummy, "squash", 0.5)
    cache, order = {}, []
    times = []
    n = 0
    t_all = time.time()
    with open(out_path, "w") as out:
        for line in open(jobs_path):
            if not line.strip():
                continue
            job = json.loads(line)
            img = cache.get(job["image"])
            if img is None:
                bgr = cv2.imread(job["image"])
                img = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
                cache[job["image"]] = img
                order.append(job["image"])
                if len(order) > 6:
                    cache.pop(order.pop(0), None)
            H, W = img.shape[:2]
            x, y, w, h = job["crop"] or [0, 0, W, H]
            x, y = max(0, int(x)), max(0, int(y))
            w, h = min(int(w), W - x), min(int(h), H - y)
            if w < 4 or h < 4:  # degenerate crop (tiny motion box clipped at the frame edge)
                out.write(json.dumps({"key": job["key"], "crop": [x, y, w, h], "dets": [], "ms": 0}) + "\n")
                continue
            dets = det.detect(img[y:y + h, x:x + w], job.get("mode", "squash"), 0.05)
            for d in dets:
                d["box"] = [d["box"][0] + x, d["box"][1] + y, d["box"][2], d["box"][3]]
            times.append(det.last_run_ms)
            out.write(json.dumps({"key": job["key"], "crop": [x, y, w, h], "dets": dets, "ms": round(det.last_run_ms, 2)}) + "\n")
            n += 1
    t = np.array(times)
    print(json.dumps({"model": os.path.basename(model_dir.rstrip('/')), "jobs": n, "wall_s": round(time.time() - t_all, 1),
                      "ort_ms_mean": round(float(t.mean()), 2) if n else None, "ort_ms_p50": round(float(np.median(t)), 2) if n else None,
                      "ort_ms_p95": round(float(np.percentile(t, 95)), 2) if n else None, "vram_mb": vram_mb(),
                      "provider": "cpu" if cpu else "cuda"}))


if __name__ == "__main__":
    main()
