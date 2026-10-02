#!/usr/bin/env python3
"""Throwaway proof harness: send the 27 real BirdNET-Go clips through a deployed kestrel-audio, sample the container's GPU
memory from the host, wait for the idle unload, and compare with the evaluation's picks.

usage: run_proof.py --label gpu --base http://192.168.1.69:8788 --container ka-proof-gpu --appdata /mnt/nvme/appdata/ka-proof-gpu \
                    [--limit N] [--idle-wait 200]
"""
import argparse, json, os, statistics, subprocess, sys, threading, time, urllib.request, urllib.error

SCI = {"Eastern Chipmunk": "Tamias striatus", "Fish Crow": "Corvus ossifragus", "Blue Jay": "Cyanocitta cristata", "Tufted Titmouse": "Baeolophus bicolor",
       "Eastern Towhee": "Pipilo erythrophthalmus", "Carolina Wren": "Thryothorus ludovicianus", "Gray Catbird": "Dumetella carolinensis",
       "Red-bellied Woodpecker": "Melanerpes carolinus", "Great Horned Owl": "Bubo virginianus", "Barred Owl": "Strix varia", "Coyote": "Canis latrans",
       "Spring Peeper": "Pseudacris crucifer", "Eastern Screech-Owl": "Megascops asio", "Eastern Gray Squirrel": "Sciurus carolinensis",
       "American Bullfrog": "Lithobates catesbeianus", "American Robin": "Turdus migratorius", "Red-shouldered Hawk": "Buteo lineatus"}

ap = argparse.ArgumentParser()
ap.add_argument("--label", required=True)
ap.add_argument("--base", required=True)
ap.add_argument("--container", required=True)
ap.add_argument("--appdata", required=True)
ap.add_argument("--limit", type=int, default=0)
ap.add_argument("--names", default="")
ap.add_argument("--idle-wait", type=int, default=200)
ap.add_argument("--out", default="")
ap.add_argument("--delete-after", action="store_true", help="DELETE every test preview from the service when done (for the deployed container)")
args = ap.parse_args()
OUT = args.out or f"/data/home/Kestrel/audio-eval/preview_eval/proof/result-{args.label}"
os.makedirs(OUT, exist_ok=True)


def sh(cmd, timeout=60):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout).stdout.strip()


def uptime_load():
    out = sh(["ssh", "unraid", "cat /proc/loadavg"])
    return [float(x) for x in out.split()[:3]]


key = sh(["ssh", "unraid", f"cat {args.appdata}/key"])
assert len(key) == 64, "could not read the key"


def http(method, path, body=None, headers=None, timeout=60):
    h = {"X-Kestrel-Audio-Key": key}
    h.update(headers or {})
    req = urllib.request.Request(args.base + path, data=body, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


picked = json.load(open("/data/home/Kestrel/audio-eval/data/preview-eval/picked.json"))
segs = json.load(open("/data/home/Kestrel/audio-eval/data/preview-eval/results/segments.json"))
epicks = json.load(open("/data/home/Kestrel/audio-eval/data/preview-eval/results/seg_picks.json"))
if args.names:
    want = set(args.names.split(","))
    picked = [c for c in picked if c["name"] in want]
if args.limit:
    picked = picked[:args.limit]

# ---- host-side sampler: GPU memory held by every process of this container (docker top gives the host PIDs)
samples = []          # (t, MiB)
stop = threading.Event()
sampler = subprocess.Popen(
    ["ssh", "unraid",
     "while true; do P=$(docker top %s -eo pid 2>/dev/null | tail -n +2 | tr -d ' ' | paste -sd,); "
     "nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader,nounits | awk -F', ' -v p=\",$P,\" "
     "'index(p, \",\"$1\",\")>0 {s+=$2} END{print s+0}'; sleep 0.4; done" % args.container],
    stdout=subprocess.PIPE, text=True)


def read_samples():
    for line in sampler.stdout:
        try:
            samples.append((time.time(), int(line.strip())))
        except ValueError:
            pass


threading.Thread(target=read_samples, daemon=True).start()

# ---- host-side sampler: the container's RAM use and CPU share (docker stats), about every 1.5 s
mem_samples = []      # (t, MiB, cpu%)
mem_proc = subprocess.Popen(
    ["ssh", "unraid", "while true; do docker stats --no-stream --format '{{.MemUsage}}|{{.CPUPerc}}' %s 2>/dev/null; done" % args.container],
    stdout=subprocess.PIPE, text=True)


def to_mib(txt):
    txt = txt.strip()
    for unit, mul in (("GiB", 1024.0), ("MiB", 1.0), ("KiB", 1 / 1024.0), ("kB", 1 / 1024.0), ("MB", 1.0), ("GB", 1024.0), ("B", 1 / 1048576.0)):
        if txt.endswith(unit):
            return float(txt[:-len(unit)]) * mul
    return float("nan")


def read_mem():
    for line in mem_proc.stdout:
        try:
            m, c = line.strip().split("|")
            mem_samples.append((time.time(), to_mib(m.split("/")[0]), float(c.strip("%"))))
        except ValueError:
            pass


threading.Thread(target=read_mem, daemon=True).start()
status_samples = []


def poll_status():
    while not stop.is_set():
        try:
            code, body = http("GET", "/v1/stats", timeout=10)
            if code == 200:
                s = json.loads(body)
                status_samples.append((time.time(), s["worker"], s["mode"], s["gpu"]))
        except Exception:
            pass
        stop.wait(0.5)


threading.Thread(target=poll_status, daemon=True).start()

load_before = uptime_load()
print(f"[{args.label}] host load before: {load_before}", flush=True)
time.sleep(1.5)
baseline = [m for _, m in samples][-3:]
rows = []
t_run0 = time.time()
for i, c in enumerate(picked):
    name = c["name"]
    det = 9000 + i
    clip = open(f"/data/home/Kestrel/audio-eval/data/preview-eval/clips/{name}.opus", "rb").read()
    q = f"detection_id={det}&species={c['species'].replace(' ', '%20')}&scientific={SCI[c['species']].replace(' ', '%20')}&camera={c['camera'].replace(' ', '%20')}"
    t0 = time.time()
    code, body = http("POST", f"/v1/jobs?{q}", body=clip, headers={"Content-Type": "audio/ogg"})
    assert code in (200, 202), (code, body)
    info = {}
    while time.time() - t0 < 900:
        code, body = http("GET", f"/v1/previews/{det}/info")
        info = json.loads(body)
        if info["state"] in ("ready", "failed"):
            break
        time.sleep(0.25)
    wall = time.time() - t0
    t1 = time.time()
    peak_vram = max([m for t, m in samples if t0 <= t <= t1 + 0.5] or [0])
    time.sleep(1.2)                                       # let the arena shrink back, then read what stays resident between clips
    resident = min([m for t, m in samples if t1 + 0.6 <= t <= t1 + 1.3] or [-1])
    peak_ram = max([m for t, m, _ in mem_samples if t0 <= t <= t1 + 1.5] or [0])
    peak_cpu = max([c for t, _, c in mem_samples if t0 <= t <= t1 + 1.5] or [0])
    full = {}
    pj = f"{args.appdata}/previews/{det}.json"
    full = json.loads(sh(["ssh", "unraid", f"cat {pj}"]) or "{}")
    if info["state"] == "ready":
        code, audio = http("GET", f"/v1/previews/{det}")
        open(f"{OUT}/{name}.m4a", "wb").write(audio)
    ev = segs[name]
    ev_pick = epicks[name]["auto"]
    seg = info.get("segment") or {}
    iou = None
    if seg:
        inter = max(0.0, min(seg["end"], ev["seg_end"]) - max(seg["start"], ev["seg_start"]))
        union = (seg["end"] - seg["start"]) + (ev["seg_end"] - ev["seg_start"]) - inter
        iou = round(inter / union, 3) if union else None
    row = {"name": name, "species": c["species"], "state": info["state"], "wall_s": round(wall, 2), "tookS": info.get("tookS"), "device": info.get("device"),
           "variant": info.get("variant"), "method": info.get("method"), "cleaned": info.get("cleaned"), "segment": seg, "scores": info.get("scores"),
           "loudnessLufs": info.get("loudnessLufs"), "durationS": info.get("durationS"), "error": info.get("error"),
           "timings": full.get("timings"), "scoresNative": full.get("scoresNative"), "truePeakDbtp": full.get("truePeakDbtp"), "bestWindow": full.get("bestWindow"),
           "vramPeakMiBSelf": full.get("vramPeakMiB"), "vramMiBEnd": full.get("vramMiB"), "host_peak_vram_mib": peak_vram, "host_resident_vram_mib": resident, "peak_ram_mib": round(peak_ram), "peak_cpu_pct": round(peak_cpu),
           "eval_segment": [ev["seg_start"], ev["seg_end"]], "eval_best_start": ev["best_start"], "eval_pick": ev_pick, "seg_iou": iou,
           "decision": full.get("decision"), "notes": full.get("notes")}
    rows.append(row)
    print(f"[{args.label}] {i+1:2d}/{len(picked)} {name:30s} {info['state']:6s} {wall:6.1f}s {str(row['variant']):7s} (eval {ev_pick:7s}) seg {seg.get('start')}-{seg.get('end')} "
          f"(eval {ev['seg_start']}-{ev['seg_end']}, IoU {iou}) scores {row['scores']} gpu-peak {peak_vram} MiB", flush=True)
t_run = time.time() - t_run0
load_after_jobs = uptime_load()
deleted = 0
if args.delete_after:
    for i in range(len(picked)):
        code, body = http("DELETE", f"/v1/previews/{9000 + i}")
        deleted += 1 if code == 200 and json.loads(body).get("deleted") else 0
    print(f"[{args.label}] deleted {deleted}/{len(picked)} test previews", flush=True)

# ---- idle unload: how long until the worker is gone and the GPU memory with it
t_idle0 = time.time()
unloaded_at = None
gone_vram = None
while time.time() - t_idle0 < args.idle_wait:
    time.sleep(2)
    if status_samples and not status_samples[-1][1]["running"]:
        unloaded_at = time.time() - t_idle0
        time.sleep(6)                                    # the host sampler lags by about a second: look at what it reports after the exit
        gone_vram = [m for t, m in samples if t > time.time() - 3.0][-3:]
        break
stop.set()
sampler.terminate()
mem_proc.terminate()
load_after = uptime_load()

mem_peak = max([m for _, m in samples] or [0])
summary = {
    "label": args.label, "n": len(rows), "ready": sum(1 for r in rows if r["state"] == "ready"), "failed": sum(1 for r in rows if r["state"] == "failed"),
    "cleaned": sum(1 for r in rows if r["cleaned"]), "total_wall_s": round(t_run, 1),
    "wall_s_median": round(statistics.median(r["wall_s"] for r in rows), 2), "wall_s_max": max(r["wall_s"] for r in rows), "wall_s_min": min(r["wall_s"] for r in rows),
    "host_baseline_vram_mib_before_load": baseline, "host_peak_vram_mib": mem_peak, "idle_unload_after_s": unloaded_at, "vram_after_unload_mib": gone_vram,
    "container_ram_peak_mib": round(max([m for _, m, _ in mem_samples if m == m] or [0])), "container_cpu_peak_pct": round(max([c for _, _, c in mem_samples] or [0])),
    "container_ram_idle_after_unload_mib": [round(m) for _, m, _ in mem_samples[-2:]],
    "deleted_test_previews": deleted if args.delete_after else None,
    "load_before": load_before, "load_after_jobs": load_after_jobs, "load_after": load_after,
    "modes_seen": sorted({s[2] for s in status_samples}), "devices_seen": sorted({r["device"] for r in rows if r["device"]}),
}
json.dump({"summary": summary, "rows": rows}, open(f"{OUT}/results.json", "w"), indent=1)
print(json.dumps(summary, indent=1))
