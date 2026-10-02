"""LOCATE: where in each 15 s clip does Perch v2 match the detected species? Scratch code (not for the repo)."""
from __future__ import annotations

import json
import sys

sys.path.insert(0, "/tmp/bsnd/lib")
import numpy as np

import bsnd

HOP = 0.5
WIN = 5.0
MAX_SPAN = 8.0
MARGIN = 0.5
CLIP = 15.0
RES = bsnd.ROOT / "results"
SEG_IN = bsnd.WORK / "seg_in"
SEG_IN.mkdir(parents=True, exist_ok=True)

clips = bsnd.picked()
raw = {c["name"]: bsnd.load_raw(c["name"]) for c in clips}
print("Perch v2 sliding windows (5 s window, 0.5 s hop) over", len(clips), "raw clips ...", flush=True)
wins = bsnd.perch_windows(raw, overlap=WIN - HOP)
json.dump(wins, open(RES / "perch_windows.json", "w"))


def pick_segment(rows, sci):
    conf = {}
    for r in rows:
        if r["sci"] == sci:
            conf[round(r["start"], 3)] = max(conf.get(round(r["start"], 3), 0.0), r["conf"])
    starts = sorted({round(r["start"], 3) for r in rows} | set(conf))
    full = [s for s in starts if s + WIN <= CLIP + 1e-6]
    c = {s: conf.get(s, 0.0) for s in full}
    best = max(c.values())
    if best <= 0.0:
        return None, c
    near = [s for s in full if c[s] >= best - 0.005]
    best_s = near[len(near) // 2]
    thr = 0.9 * best
    i = full.index(best_s)
    lo = hi = i
    while lo > 0 and c[full[lo - 1]] >= thr and abs(full[lo] - full[lo - 1] - HOP) < 1e-6:
        lo -= 1
    while hi < len(full) - 1 and c[full[hi + 1]] >= thr and abs(full[hi + 1] - full[hi] - HOP) < 1e-6:
        hi += 1
    run = full[lo:hi + 1]
    span = (run[0], run[-1] + WIN)
    if span[1] - span[0] > MAX_SPAN + 1e-6:
        cand = np.arange(span[0], span[1] - MAX_SPAN + 1e-9, HOP)
        score = lambda x: sum(c[s] for s in run if x - 1e-9 <= s <= x + (MAX_SPAN - WIN) + 1e-9)
        centre = best_s + WIN / 2
        x = max(cand, key=lambda x: (round(score(x), 6), -abs(x + MAX_SPAN / 2 - centre)))
        span = (float(x), float(x) + MAX_SPAN)
    return {"best_start": best_s, "best_conf": best, "run_start": run[0], "run_end": run[-1] + WIN, "span": span,
            "n_high": len(run)}, c


bn = json.load(open("/tmp/bsnd/bnet_timing.json")) if (bsnd.ROOT / "bnet_timing.json").exists() else {}
ids = json.load(open(bsnd.ROOT / "detection_ids.json"))
segs = {}
for c in clips:
    name = c["name"]
    sci = bsnd.SCI[c["species"]]
    info, curve = pick_segment(wins[name], sci)
    if info is None:
        # the species never reached the 0.0002 floor in any window: fall back to BirdNET-Go's own begin (3 s into the clip)
        s0, s1 = 3.0 - MARGIN, 3.0 + WIN + MARGIN
        info = {"best_start": 3.0, "best_conf": 0.0, "run_start": 3.0, "run_end": 8.0, "span": (3.0, 8.0), "n_high": 0, "fallback": "species below Perch floor in every window; used BirdNET-Go's begin"}
    s0 = max(0.0, info["span"][0] - MARGIN)
    s1 = min(CLIP, info["span"][1] + MARGIN)
    info.update({"seg_start": s0, "seg_end": s1, "sci": sci, "curve": {str(k): v for k, v in curve.items()}})
    # BirdNET-Go timing: its clip starts 3 s before 'beginTime' and runs 12 s after it
    t = bn.get(str(ids[name]))
    if t:
        info["bnet"] = {"begin_offset_s": 3.0, "capture_span_s": 12.0, "beginTime": t.get("beginTime"), "endTime": t.get("endTime"), "timestamp": t.get("timestamp")}
    x = raw[name][int(round(s0 * bsnd.SR)): int(round(s1 * bsnd.SR))]
    peak = float(np.max(np.abs(x))) or 1.0
    info["seg_scale"] = 0.9 / peak
    np.save(SEG_IN / f"{name}.npy", (x * (0.9 / peak)).astype(np.float32))
    segs[name] = info
    print(f"{name:32s} best {info['best_start']:4.1f}s conf {info['best_conf']:.2f}  run {info['run_start']:4.1f}-{info['run_end']:4.1f}  segment {s0:4.1f}-{s1:4.1f} ({s1 - s0:.1f}s)", flush=True)
json.dump(segs, open(RES / "segments.json", "w"), indent=1)
