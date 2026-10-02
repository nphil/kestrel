#!/usr/bin/env python3
"""Measure models on the shared Tesla P40 through the scrypted container's onnxruntime-gpu (the ONLY CUDA runtime we have).

usage: bench_p40.py [--force] [--mem-limit-mb 1024] [--max-seconds 0] name [name ...]

Per model (strictly one at a time, only if the GPU has < 17000 MiB in use; aborts the run if total GPU memory ever
exceeds 22000 MiB so the llama-swap model loads are never starved):
  1. streams model.onnx + the worker + a random and a real-image input into /tmp/bm inside the container (nothing else
     in the container is touched; /tmp/bm is deleted afterwards)
  2. runs bench_one_ort.py in the container (CUDA EP, gpu_mem_limit, 10+ warm-up calls, 100 timed calls)
  3. while it runs, samples `nvidia-smi --query-compute-apps` on the host for that process -> peak process VRAM
  4. copies the GPU outputs back and compares them with onnxruntime-CPU (max abs diff of the whole output tensor)
Writes models/<name>/bench_p40.json. A model that does not fit into the memory limit is reported as such; with
--mem-limit-mb you can re-run it once with a bigger limit (keep it short: --max-seconds 20).
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))
import modelkit as mk  # noqa: E402
MODELS = ROOT / "models"
CONTAINER = os.environ.get("GPU_CONTAINER", "de-models-gpu")      # own throwaway container, see gpu_container.sh
assert CONTAINER not in ("scrypted", "homeassistant", "llama-swap"), "never run experiments in a production container"
MIN_RAM_GB = 10                                                    # Main's rule: host `available` must be >= 10 GB
FREE_BELOW_MIB = 17000
ABORT_ABOVE_MIB = 22000
REAL_IMG = ROOT / "data/truth/raccoon_snap.jpg"


def ssh(cmd: str, **kw) -> subprocess.CompletedProcess:
    return subprocess.run(["ssh", "unraid", cmd], capture_output=True, text=True, **kw)


def gpu_used_mib() -> int:
    r = ssh("nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits")
    return int(r.stdout.strip().splitlines()[0])


def host_ram_available_gb() -> int:
    return int(ssh("free -g | awk '/^Mem:/ {print $7}'").stdout.strip())


def gpu_util_max(samples: int = 5) -> int:
    r = ssh(f"for i in $(seq {samples}); do nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits; sleep 0.3; done")
    return max(int(x) for x in r.stdout.split())


def wait_for_gpu(max_wait_s: int = 3600) -> int:
    """Block until: GPU memory in use < 17000 MiB, host RAM available >= 10 GB and nobody else is loading the GPU (< 30 % util)."""
    t0 = time.time()
    while True:
        u, ram, util = gpu_used_mib(), host_ram_available_gb(), gpu_util_max()
        if u < FREE_BELOW_MIB and ram >= MIN_RAM_GB and util < 30:
            return u
        if time.time() - t0 > max_wait_s:
            raise SystemExit(f"gave up waiting: GPU {u} MiB, RAM available {ram} GB, util {util} %")
        print(f"  waiting: GPU {u} MiB (<{FREE_BELOW_MIB}), RAM avail {ram} GB (>={MIN_RAM_GB}), util {util} % (<30)", flush=True)
        time.sleep(30)


def stream_to_container(local: Path, remote: str) -> None:
    with open(local, "rb") as f:
        r = subprocess.run(["ssh", "unraid", f"docker exec -i {CONTAINER} sh -c 'cat > {remote}'"], stdin=f,
                           capture_output=True)
    if r.returncode:
        raise RuntimeError(f"stream failed: {r.stderr.decode()[:300]}")


def make_inputs(w: int, h: int, tmp: Path) -> tuple[Path, Path]:
    rng = np.random.default_rng(0)
    rand = rng.random((1, 3, h, w), dtype=np.float32)
    img = Image.open(REAL_IMG).convert("RGB").resize((w, h), Image.BILINEAR)
    real = np.ascontiguousarray(np.asarray(img, dtype=np.uint8).transpose(2, 0, 1)[None].astype(np.float32) / 255.0)
    pr, pe = tmp / f"rand_{w}x{h}.npy", tmp / f"real_{w}x{h}.npy"
    np.save(pr, rand)
    np.save(pe, real)
    return pr, pe


REMOTE = r"""
set -u
C={cont}; W=/tmp/bm
BASE=" $(nvidia-smi --query-compute-apps=pid --format=csv,noheader | tr -d ' ' | sort | tr '\n' ' ') "
docker exec $C /usr/bin/python3.12 $W/bench_one_ort.py --model $W/model.onnx --rand $W/rand.npy \
  --real $W/real.npy --mem-limit-mb {lim} --iters 100 --rounds {rounds} --max-seconds {maxs} --sporadic {spor} --gap-s 2.0 --out-prefix $W/out_ > /tmp/bm_stdout.txt 2> /tmp/bm_stderr.txt &
BG=$!
HP=""
for i in $(seq 1 150); do
  HP=$(docker top $C -eo pid,args 2>/dev/null | awk '/bench_one_ort/ && !/awk/ && !/docker/ {{print $1; exit}}')
  [ -n "$HP" ] && break
  sleep 0.1
done
: > /tmp/bm_vram.txt; : > /tmp/bm_total.txt
ABORT=0; CONT=0
while kill -0 $BG 2>/dev/null; do
  APPS=$(nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader,nounits 2>/dev/null)
  echo "$APPS" | awk -F', ' -v p="$HP" '$1==p {{print $2}}' >> /tmp/bm_vram.txt
  for NP in $(echo "$APPS" | awk -F', ' -v p="$HP" '$1!=p && $2>150 {{print $1}}'); do
    case "$BASE" in *" $NP "*) ;; *) CONT=1;; esac        # a new GPU process (another agent's job) appeared during the run
  done
  T=$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits)
  echo $T >> /tmp/bm_total.txt
  if [ "$T" -gt {abort} ]; then docker exec $C pkill -f bench_one_ort; ABORT=1; fi
  sleep 0.15
done
wait $BG
echo "HOSTPID $HP ABORT $ABORT CONTENDED $CONT"
echo "PEAKPROC $(sort -n /tmp/bm_vram.txt | tail -1)"
echo "PEAKTOTAL $(sort -n /tmp/bm_total.txt | tail -1) FIRSTTOTAL $(head -1 /tmp/bm_total.txt)"
cat /tmp/bm_stdout.txt
echo "---STDERR"; head -c 3000 /tmp/bm_stderr.txt
"""


def bench(name: str, mem_limit_mb: int, max_seconds: float, force: bool, sporadic: int = 8, tag: str = "", _retry: int = 0, rounds: int = 3) -> dict | None:
    d = MODELS / name
    out_json = d / ((f"bench_p40{tag}.json") if mem_limit_mb == 1024 else f"bench_p40{tag}_{mem_limit_mb}mb.json")
    if out_json.exists() and not force:
        print(f"{name}: already benchmarked ({out_json.name})")
        return json.loads(out_json.read_text())
    meta = json.loads((d / "meta.json").read_text())
    w, h = meta["input"]["w"], meta["input"]["h"]
    free0 = wait_for_gpu()
    tmp = Path("/tmp/bm_local")
    tmp.mkdir(exist_ok=True)
    pr, pe = make_inputs(w, h, tmp)
    print(f"{name}: GPU used {free0} MiB before; streaming {(d / 'model.onnx').stat().st_size / 1e6:.0f} MB ...", flush=True)
    ssh(f"docker exec {CONTAINER} rm -rf /tmp/bm && docker exec {CONTAINER} mkdir -p /tmp/bm")
    try:
        stream_to_container(d / "model.onnx", "/tmp/bm/model.onnx")
        stream_to_container(pr, "/tmp/bm/rand.npy")
        stream_to_container(pe, "/tmp/bm/real.npy")
        stream_to_container(HERE / "bench_one_ort.py", "/tmp/bm/bench_one_ort.py")
        if gpu_used_mib() >= FREE_BELOW_MIB + 3000:
            raise SystemExit("GPU got busy while copying; aborting")
        t0 = time.time()
        r = subprocess.run(["ssh", "unraid", "bash -s"], input=REMOTE.format(cont=CONTAINER, lim=mem_limit_mb, abort=ABORT_ABOVE_MIB,
                                                                              maxs=max_seconds, spor=sporadic, rounds=rounds),
                           capture_output=True, text=True, timeout=1500)
        wall = time.time() - t0
        txt = r.stdout
        res: dict = {"model": name, "mem_limit_mb": mem_limit_mb, "wall_s": round(wall, 1), "gpu_used_before_mib": free0}
        for line in txt.splitlines():
            if line.startswith("RESULT "):
                res.update(json.loads(line[7:]))
            elif line.startswith("PEAKPROC"):
                v = line.split()[1:]
                res["peak_process_vram_mib"] = int(v[0]) if v else None
            elif line.startswith("PEAKTOTAL"):
                p = line.split()
                res["gpu_total_peak_mib"], res["gpu_total_first_mib"] = int(p[1]), int(p[3])
            elif line.startswith("HOSTPID"):
                p = line.split()
                res["host_pid"], res["aborted_by_watchdog"], res["contended"] = p[1], p[3] == "1", p[5] == "1"
        err = txt.split("---STDERR", 1)[-1].strip() if "---STDERR" in txt else ""
        if "rand" not in res:
            res["failed"] = True
            res["stderr_tail"] = err[-1500:]
            print(f"{name}: FAILED\n{err[-1500:]}")
        else:
            res["cpu_fallback_warning"] = ("not assigned to the preferred execution providers" in err) or ("Memcpy" in err)
            res["stderr_tail"] = err[-600:]
            # copy outputs back and compare with CPU (skipped when the 4 GB local cap makes the CPU run impossible)
            import onnxruntime as ort
            gpu_outs = {}
            for tag in ("rand", "real"):
                g = subprocess.run(["ssh", "unraid", f"docker exec {CONTAINER} cat /tmp/bm/out_{tag}.npy"], capture_output=True).stdout
                tmpf = tmp / f"gpu_out_{tag}.npy"
                tmpf.write_bytes(g)
                gpu_outs[tag] = np.load(tmpf)
            try:
                so = ort.SessionOptions()
                so.intra_op_num_threads = 6
                sess = ort.InferenceSession(str(d / "model.onnx"), so, providers=["CPUExecutionProvider"])
                iname = sess.get_inputs()[0].name
                for tag, p in (("rand", pr), ("real", pe)):
                    cpu_out = sess.run(None, {iname: np.load(p)})[0]
                    cmp_ = mk.compare_outputs(cpu_out, gpu_outs[tag], meta["output"]["format"])
                    res[f"gpu_vs_cpu_{tag}"] = cmp_
                    res[f"gpu_vs_cpu_maxdiff_{tag}"] = cmp_["max_abs_diff_scores"]   # class scores / objectness*cls, 0..1
            except Exception as e:  # noqa: BLE001  (e.g. std::bad_alloc under prlimit --as=4G for the 1280 px models)
                res["gpu_vs_cpu_skipped"] = f"{type(e).__name__}: {str(e)[:120]}"
                res["gpu_vs_cpu_maxdiff_real"] = None
            print(f"{name}: rand {res['rand']['median_ms']} ms  real {res['real']['median_ms']} ms  sporadic {res.get('sporadic', {}).get('median_ms')} ms  peak proc VRAM "
                  f"{res.get('peak_process_vram_mib')} MiB  providers={res['providers']}  gpu-vs-cpu score diff {res['gpu_vs_cpu_maxdiff_real'] if res['gpu_vs_cpu_maxdiff_real'] is None else format(res['gpu_vs_cpu_maxdiff_real'], '.1e')}")
        if res.get("contended") and _retry < 3:
            print(f"{name}: another GPU job appeared during the run -> retrying in 30 s", flush=True)
            time.sleep(30)
            return bench(name, mem_limit_mb, max_seconds, True, sporadic, tag, _retry + 1, rounds)
        out_json.write_text(json.dumps(res, indent=2) + "\n")
        return res
    finally:
        ssh(f"docker exec {CONTAINER} rm -rf /tmp/bm; rm -f /tmp/bm_stdout.txt /tmp/bm_stderr.txt /tmp/bm_vram.txt /tmp/bm_total.txt")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("names", nargs="+")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--mem-limit-mb", type=int, default=1024)
    ap.add_argument("--max-seconds", type=float, default=0)
    ap.add_argument("--rounds", type=int, default=3)
    ap.add_argument("--sporadic", type=int, default=8, help="production-like calls 2 s apart (0 = skip)")
    ap.add_argument("--pause-daemon", action="store_true",
                    help="`gputune pause 30` around the run (clean continuous numbers, no idle-power wake-ups); results go to bench_p40_paused.json")
    a = ap.parse_args()
    if a.pause_daemon:
        ssh("gputune pause 30")
    try:
        for n in a.names:
            bench(n, a.mem_limit_mb, a.max_seconds, a.force, 0 if a.pause_daemon else a.sporadic,
                  "_paused" if a.pause_daemon else "", 0, a.rounds)
    finally:
        if a.pause_daemon:
            ssh("gputune resume")


if __name__ == "__main__":
    main()
