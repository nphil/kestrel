"""Encode listening-page audio (AAC .m4a) + spectrogram strips for the matched-segment design; write site/data.json. Scratch code."""
from __future__ import annotations

import datetime as dt
import json
import pathlib
import subprocess
import sys

sys.path.insert(0, "/tmp/bsnd/lib")
import matplotlib
import numpy as np

matplotlib.use("Agg")
import matplotlib.pyplot as plt

import bsnd
import viz

SITE = bsnd.ROOT / "site"
for sub in ("audio", "img"):
    d = SITE / sub
    d.mkdir(parents=True, exist_ok=True)
    for f in d.glob("*"):
        f.unlink()
CAND = bsnd.WORK / "seg_cand"
RES = bsnd.ROOT / "results"
viz.VMIN, viz.VMAX = -93.0, -23.0     # clips are normalised to -16 LUFS now

picks = json.loads((RES / "seg_picks.json").read_text())

HOW = {
    "G04": "hiss turned down a little", "G07": "hiss turned down", "G10": "hiss turned down more", "G15": "hiss turned down a lot", "G20": "hiss turned down hard",
    "M4": "AI kept the animal's track (4 tracks)", "M4S": "AI kept every matching track (4 tracks)",
    "M8": "AI kept the animal's track (8 tracks)", "M8S": "AI kept every matching track (8 tracks)",
    "MR4_50": "AI turned the other tracks down 6 dB (4 tracks)", "MR4_25": "AI turned the other tracks down 12 dB (4 tracks)", "MR4_12": "AI turned the other tracks down 18 dB (4 tracks)",
    "MR8_50": "AI turned the other tracks down 6 dB (8 tracks)", "MR8_25": "AI turned the other tracks down 12 dB (8 tracks)", "MR8_12": "AI turned the other tracks down 18 dB (8 tracks)",
    "M4G": "AI kept the animal's track + hiss pass (4 tracks)", "M4SG": "AI kept every matching track + hiss pass (4 tracks)", "M8G": "AI kept the animal's track + hiss pass (8 tracks)",
}

segs = json.loads((RES / "segments.json").read_text())
rows = json.loads((RES / "seg_metrics.json").read_text())
by = {}
for r in rows:
    by.setdefault(r["name"], {})[r["cand"]] = r


ENC_LOG = {}


def _encode(y, out):
    p = subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(bsnd.SR), "-ac", "1", "-i", "-",
                        "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", str(out)],
                       input=np.clip(y, -1, 1).astype("<f4").tobytes(), capture_output=True)
    if p.returncode != 0:
        raise RuntimeError(p.stderr.decode()[-400:])
    d = subprocess.run(["ffmpeg", "-v", "error", "-i", str(out), "-f", "f32le", "-ac", "1", "-ar", str(bsnd.SR), "-"], capture_output=True)
    return np.frombuffer(d.stdout, dtype="<f4")


def encode_m4a(y, out):
    """AAC encode, then decode and measure: AAC overshoots the limiter ceiling by a fraction of a dB (more on sparse, heavily limited audio),
    so trim the gain until the DECODED file stays at or under -1 dBTP. Logs the measured LUFS / true peak of what is delivered."""
    y = y.astype(np.float32)
    trim = 0.0
    for _ in range(6):
        dec = _encode(y * 10 ** (trim / 20), out)
        tp = bsnd.true_peak_db(dec)
        if tp <= -1.0 + 0.02:
            break
        trim -= (tp + 1.0) + 0.15
    ENC_LOG[pathlib.Path(out).name] = {"lufs": float(bsnd.lufs(dec)), "tp": float(tp), "trim_db": float(trim)}


def style(ax):
    for s in ax.spines.values():
        s.set_visible(False)
    ax.tick_params(colors="#B9B3C9", length=2)


def spec_segment(y, s0, s1, out):
    fig = plt.figure(figsize=(8, 2.0), dpi=100, facecolor="#120E1A")
    ax = fig.add_axes([0.04, 0.16, 0.955, 0.82], facecolor="#120E1A")
    f, t, S = viz.spec_data(y)
    ax.pcolormesh(t + s0, f, S, vmin=viz.VMIN, vmax=viz.VMAX, cmap="magma", shading="auto", rasterized=True)
    ax.set_yscale("function", functions=(np.sqrt, np.square)); ax.set_ylim(80, 8000)
    ax.set_yticks([250, 500, 1000, 2000, 4000, 8000]); ax.set_yticklabels([".25", ".5", "1", "2", "4", "8k"], fontsize=9)
    ax.minorticks_off()
    ticks = list(np.arange(np.ceil(s0), s1 + 1e-6, 1.0))
    ax.set_xlim(s0, s1)
    ax.set_xticks(ticks); ax.set_xticklabels([f"{int(x)}" + (" s" if i == len(ticks) - 1 else "") for i, x in enumerate(ticks)], fontsize=9)
    style(ax)
    fig.savefig(out, format="jpg", pil_kwargs={"quality": 80}); plt.close(fig)


def spec_original(y, s0, s1, curve, best_start, sci_label, out):
    fig = plt.figure(figsize=(8, 3.1), dpi=100, facecolor="#120E1A")
    ax = fig.add_axes([0.04, 0.36, 0.955, 0.61], facecolor="#120E1A")
    f, t, S = viz.spec_data(y)
    ax.pcolormesh(t, f, S, vmin=viz.VMIN, vmax=viz.VMAX, cmap="magma", shading="auto", rasterized=True)
    ax.set_yscale("function", functions=(np.sqrt, np.square)); ax.set_ylim(80, 8000)
    ax.set_yticks([250, 500, 1000, 2000, 4000, 8000]); ax.set_yticklabels([".25", ".5", "1", "2", "4", "8k"], fontsize=9)
    ax.minorticks_off(); ax.set_xlim(0, 15); ax.set_xticks([])
    ax.axvspan(s0, s1, color="white", alpha=0.13, lw=0)
    for x in (s0, s1):
        ax.axvline(x, color="#9CCFD8", lw=1.4)
    ax.text((s0 + s1) / 2, 7200, "preview", color="#9CCFD8", fontsize=10, ha="center", va="top", fontweight="bold")
    style(ax)
    ax2 = fig.add_axes([0.04, 0.15, 0.955, 0.17], facecolor="#120E1A")
    xs = np.array(sorted(float(k) for k in curve)) + 2.5
    ys = np.array([curve[str(k)] if str(k) in curve else curve[f"{k}"] for k in sorted(float(k) for k in curve)])
    ax2.fill_between(xs, ys, color="#C4A7E7", alpha=0.55, lw=0, step="mid")
    ax2.plot(xs, ys, color="#C4A7E7", lw=1.2)
    ax2.axvspan(s0, s1, color="white", alpha=0.13, lw=0)
    for x in (s0, s1):
        ax2.axvline(x, color="#9CCFD8", lw=1.4)
    ax2.set_xlim(0, 15); ax2.set_ylim(0, 1.0)
    ax2.set_yticks([0, 1]); ax2.set_yticklabels(["0", "1"], fontsize=9)
    ax2.set_xticks([0, 3, 6, 9, 12, 15]); ax2.set_xticklabels(["0", "3", "6", "9", "12", "15 s"], fontsize=9)
    ax2.text(0.15, 0.95, f"Perch: how sure it is a {sci_label}", color="#B9B3C9", fontsize=8.5, va="top")
    style(ax2)
    fig.savefig(out, format="jpg", pil_kwargs={"quality": 80}); plt.close(fig)


def local_time(iso):
    return dt.datetime.fromisoformat(iso).strftime("%a %b %-d, %-I:%M %p")


data = []
for c in bsnd.picked():
    n = c["name"]
    sg = segs[n]
    s0, s1 = sg["seg_start"], sg["seg_end"]
    raw = bsnd.load_raw(n)
    clip_final, _ = bsnd.normalize(raw * (0.9 / np.abs(raw).max()), target=-16.0, tp_db=-1.0)   # pre-scale: some raw clips sit below BS.1770's -70 LUFS gate
    encode_m4a(clip_final, SITE / "audio" / f"{n}__A.m4a")
    spec_original(clip_final, s0, s1, sg["curve"], sg["best_start"], c["species"], SITE / "img" / f"{n}__A.jpg")
    o = by[n]["orig"]
    p = picks[n]
    timing_ok = sg["best_start"] >= 1.0      # >= 3 of the best 5 s window lies inside BirdNET-Go's 3-15 s span
    entry = {"name": n, "species": c["species"], "camera": c["camera"], "bnet_score": c["score"], "when": local_time(sg["bnet"]["beginTime"]),
             "s0": round(s0, 2), "s1": round(s1, 2), "best_start": sg["best_start"], "best_conf": round(sg["best_conf"], 3),
             "perch_orig": round(o["perch_raw_level"], 3), "perch_orig_final": round(o["perch_final"], 3), "timing_ok": bool(timing_ok),
             "timing_note": "" if timing_ok else "Perch's best moment is mostly before BirdNET-Go's 3\u201315 s window",
             "cands": [{"letter": "A", "dur": 15.0, "s0": 0.0}]}
    yb = np.load(CAND / f"{n}__orig__final.npy")
    encode_m4a(yb, SITE / "audio" / f"{n}__B.m4a")
    spec_segment(yb, s0, s1, SITE / "img" / f"{n}__B.jpg")
    entry["cands"].append({"letter": "B", "cid": "orig", "dur": round(len(yb) / bsnd.SR, 2), "s0": round(s0, 2), "pick": p["auto_letter"] == "B"})
    for letter in "CDE":
        cid = p[letter]
        y = np.load(CAND / f"{n}__{cid}__final.npy")
        encode_m4a(y, SITE / "audio" / f"{n}__{letter}.m4a")
        spec_segment(y, s0, s1, SITE / "img" / f"{n}__{letter}.jpg")
        m = by[n][cid]
        entry["cands"].append({"letter": letter, "cid": cid, "how": HOW[cid], "ok": bool(p[f"{letter}_ok"]), "dur": round(len(y) / bsnd.SR, 2), "s0": round(s0, 2),
                               "perch": round(m["perch_raw_level"], 3), "perch_final": round(m["perch_final"], 3),
                               "supp_db": round(m["quiet_suppression_db"], 1), "contrast": round(m["contrast_hi_db"], 1), "lufs": round(m["lufs_out"], 1),
                               "pick": p["auto_letter"] == letter})
    data.append(entry)
    print("built", n, flush=True)
(SITE / "data.json").write_text(json.dumps(data, indent=1))
(RES / "seg_encoded_levels.json").write_text(json.dumps(ENC_LOG, indent=1))
print("clips", len(data))
