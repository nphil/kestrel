"""Throwaway: how much GPU memory do the ORT sessions really take, and how fast are they? Runs inside ka-dev:cuda12.
usage: gpu_probe.py <perch_cap_mib> <mixit4_cap_mib> <mixit8_cap_mib> [batch]
"""
import json, os, subprocess, sys, threading, time
import numpy as np

sys.path.insert(0, "/app")
from kestrel_audio import gpu
from kestrel_audio.perch import make_session, LABELS_FILE, MODEL_FILE
from kestrel_audio.scoring import make_windows
from kestrel_audio.codec import decode_file, SR

perch_cap, m4_cap, m8_cap = (int(a) for a in sys.argv[1:4])
batch = int(sys.argv[4]) if len(sys.argv) > 4 else 8
M = "/models"


def apps():
    out = subprocess.check_output(["nvidia-smi", "--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"], text=True)
    d = {}
    for ln in out.strip().splitlines():
        a, b = [t.strip() for t in ln.split(",")]
        d[int(a)] = int(b)
    return d


BASE_PIDS = set(apps())


def used_mib():
    """GPU memory held by THIS probe: the compute processes that were not there when it started (other users of the GPU come and go)."""
    return sum(m for pid, m in apps().items() if pid not in BASE_PIDS)


samples, stop = [], threading.Event()


def poll():
    while not stop.is_set():
        samples.append((time.time(), used_mib()))
        time.sleep(0.05)


base = 0
th = threading.Thread(target=poll, daemon=True); th.start()
marks = {}


def mark(name):
    marks[name] = (time.time(), max(u for _, u in samples[-5:]) if samples else base)


def peak_since(t0):
    v = [u for t, u in samples if t >= t0]
    return (max(v) - base) if v else None


mark("start")
t0 = time.time()
perch = make_session(f"{M}/{MODEL_FILE}", device="cuda", threads=1, vram_mib=perch_cap)
print("perch session created", round(time.time() - t0, 2), "s;  +%s MiB" % peak_since(t0), flush=True)
x = decode_file("/clips/Barred_Owl_aab49d.opus", SR)
starts, W = make_windows(x, full_only=True)
print("windows", W.shape, flush=True)
inp = perch.get_inputs()[0].name
for b in (1, batch):
    t = time.time(); out = perch.run(["label"], {inp: W[:b]})[0]; print(f"  first run batch {b}: {time.time()-t:.2f}s", flush=True)
ts = []
for _ in range(3):
    t = time.time()
    for i in range(0, len(W), batch):
        perch.run(["label"], {inp: W[i:i + batch]})
    ts.append(time.time() - t)
print(f"perch: {len(W)} windows in {np.median(ts):.2f}s steady (batch {batch}) -> {len(W)/np.median(ts):.1f} windows/s;  peak so far +{peak_since(t0)} MiB", flush=True)
perch_peak = peak_since(t0)

if m4_cap:
    t1 = time.time()
    m4 = make_session(f"{M}/mixit4.onnx", device="cuda", threads=1, vram_mib=m4_cap)
    seg = np.load("/seg/Barred_Owl_aab49d.npy").astype(np.float32)[None, None, :]
    for i in range(4):
        t = time.time(); m4.run(None, {m4.get_inputs()[0].name: seg}); dt = time.time() - t
        print(f"  mixit4 run {i}: {dt:.2f}s", flush=True)
    print(f"after mixit4: peak +{peak_since(t0)} MiB", flush=True)
if m8_cap:
    m8 = make_session(f"{M}/mixit8.onnx", device="cuda", threads=1, vram_mib=m8_cap)
    for i in range(4):
        t = time.time(); m8.run(None, {m8.get_inputs()[0].name: seg}); dt = time.time() - t
        print(f"  mixit8 run {i}: {dt:.2f}s", flush=True)
    print(f"after mixit8: peak +{peak_since(t0)} MiB", flush=True)
# a bigger Perch batch after the MixIT sessions exist (the realistic worst case: everything resident)
for i in range(0, len(W), batch):
    perch.run(["label"], {inp: W[i:i + batch]})
time.sleep(0.5)
stop.set(); th.join()
print(json.dumps({"caps": [perch_cap, m4_cap, m8_cap], "batch": batch, "baseline_mib": base, "own_mib_now": used_mib(), "peak_delta_mib": peak_since(t0), "perch_only_peak_mib": perch_peak,
                  "settled_delta_mib": used_mib() - base}))
