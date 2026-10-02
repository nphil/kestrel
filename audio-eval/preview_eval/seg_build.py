"""ISOLATE + AMPLIFY + VERIFY on the Perch-matched segment of each clip. Scratch code (not for the repo)."""
from __future__ import annotations

import json
import sys
import time

sys.path.insert(0, "/tmp/bsnd/lib")
import numpy as np

import bsnd
import dsp

SR = bsnd.SR
RES = bsnd.ROOT / "results"
W = bsnd.WORK
CAND = W / "seg_cand"
CAND.mkdir(parents=True, exist_ok=True)
TARGET, TP = -16.0, -1.0
TAU = 0.30              # a source is "matching" if its species score >= TAU * the best source's score ...
TAU_MIN = 0.02          # ... and at least this absolute Perch confidence
FADE_MS = 75

segs = json.loads((RES / "segments.json").read_text())
clips = bsnd.picked()
t4 = json.loads((W / "seg_src4" / "timing_4src.json").read_text())
t8 = json.loads((W / "seg_src8" / "timing_8src.json").read_text())
gpu_t = {"4": {r["name"]: r["wall_s"] for r in t4["per_clip"]}, "8": {r["name"]: r["wall_s"] for r in t8["per_clip"]}}


def fade(y, ms=FADE_MS):
    n = int(ms * 1e-3 * SR)
    w = 0.5 - 0.5 * np.cos(np.pi * np.arange(n) / n)
    y = y.astype(np.float32).copy()
    y[:n] *= w
    y[-n:] *= w[::-1]
    return y


def best_conf(rows, sci):
    v = [r["conf"] for r in rows if r["sci"] == sci]
    return max(v) if v else 0.0


def top_any(rows):
    if not rows:
        return "-", 0.0
    r = max(rows, key=lambda r: r["conf"])
    return r["sci"], r["conf"]


# ------------------------------------------------------------------ collect arrays
D = {}
for c in clips:
    n = c["name"]
    sg = segs[n]
    raw = bsnd.load_raw(n)
    i0, i1 = int(round(sg["seg_start"] * SR)), int(round(sg["seg_end"] * SR))
    x = raw[i0:i1]
    scale = sg["seg_scale"]
    D[n] = {
        "c": c, "sg": sg, "raw": raw, "x": x, "scale": scale, "xs": x * scale,
        "src4": np.stack([np.load(W / "seg_src4" / f"{n}__s{k}.npy") for k in range(4)]),
        "src8": np.stack([np.load(W / "seg_src8" / f"{n}__s{k}.npy") for k in range(8)]),
        "sci": bsnd.SCI[c["species"]],
    }

# ------------------------------------------------------------------ Perch on the original segment and every separated source (at the ORIGINAL amplitude)
items = {}
for n, d in D.items():
    items[f"{n}__orig"] = d["x"]
    for k in range(4):
        items[f"{n}__a{k}"] = d["src4"][k] / d["scale"]
    for k in range(8):
        items[f"{n}__b{k}"] = d["src8"][k] / d["scale"]
print("Perch on", len(items), "arrays (original segment + separated sources) ...", flush=True)
t0 = time.time()
w1 = bsnd.perch_windows(items, overlap=4.5)
print("perch", round(time.time() - t0, 1), "s", flush=True)

sel = {}
for n, d in D.items():
    sci = d["sci"]
    s = {"orig_raw": best_conf(w1[f"{n}__orig"], sci)}
    for tag, K in (("a", 4), ("b", 8)):
        confs = [best_conf(w1[f"{n}__{tag}{k}"], sci) for k in range(K)]
        fb = ""
        if max(confs) <= 0.0:
            tops = [top_any(w1[f"{n}__{tag}{k}"])[1] for k in range(K)]
            top = int(np.argmax(tops))
            fb = "no source scored the detected species; picked highest any-species"
        else:
            top = int(np.argmax(confs))
        thr = max(TAU * confs[top], TAU_MIN) if confs[top] > 0 else 1e9
        passing = [k for k in range(K) if confs[k] >= thr] or [top]
        s[tag] = {"confs": confs, "top": top, "passing": passing, "fallback": fb}
    sel[n] = s
json.dump(sel, open(RES / "seg_selection.json", "w"), indent=1)

# ------------------------------------------------------------------ build variants (pre-normalisation, scaled domain)
timing_cpu = {}
variants = {}   # name -> {cand: array in scaled domain}
for n, d in D.items():
    xs, scale = d["xs"], d["scale"]
    lam_clip = dsp.noise_psd(np.abs(dsp._stft(d["raw"] * scale)[2]) ** 2)   # clip-level stationary noise, same scaling
    a, b = sel[n]["a"], sel[n]["b"]
    v, t = {}, {}

    def timed(label, fn):
        t0 = time.perf_counter()
        y = fn()
        t[label] = time.perf_counter() - t0
        return y

    v["G15"] = timed("G15", lambda: dsp.wiener_dd(xs, floor_db=-15.0, lam=lam_clip))
    v["G20"] = timed("G20", lambda: dsp.wiener_dd(xs, floor_db=-20.0, lam=lam_clip))
    v["M4"] = d["src4"][a["top"]]
    v["M4G"] = timed("gate_after_M4", lambda: dsp.wiener_dd(v["M4"], floor_db=-12.0))
    sum4 = d["src4"][a["passing"]].sum(axis=0)
    v["M4S"] = sum4
    v["M4SG"] = dsp.wiener_dd(sum4, floor_db=-12.0)
    v["M8"] = d["src8"][b["top"]]
    v["M8G"] = dsp.wiener_dd(v["M8"], floor_db=-12.0)
    sum8 = d["src8"][b["passing"]].sum(axis=0)
    v["M8S"] = sum8
    variants[n] = v
    timing_cpu[n] = t

CANDS = ["G15", "G20", "M4", "M4G", "M4S", "M4SG", "M8", "M8G", "M8S"]

# ------------------------------------------------------------------ amplify: fades + -16 LUFS / -1 dBTP
final, norm = {}, {}
orig_clip_final = {}
for n, d in D.items():
    y, info = bsnd.normalize(fade(d["xs"]), target=TARGET, tp_db=TP)
    final[f"{n}__orig"], norm[f"{n}__orig"] = y, info
    for cand in CANDS:
        y, info = bsnd.normalize(fade(variants[n][cand]), target=TARGET, tp_db=TP)
        final[f"{n}__{cand}"], norm[f"{n}__{cand}"] = y, info
    yc, infoc = bsnd.normalize(d["raw"], target=TARGET, tp_db=TP)
    orig_clip_final[n] = (yc, infoc)
    np.save(CAND / f"{n}__clip_final.npy", yc)
    for key in [f"{n}__orig"] + [f"{n}__{c}" for c in CANDS]:
        np.save(CAND / f"{key}__final.npy", final[key])
    np.save(CAND / f"{n}__orig__raw.npy", d["x"])
    for cand in CANDS:
        np.save(CAND / f"{n}__{cand}__pre.npy", fade(variants[n][cand]) / d["scale"])   # raw amplitude units

# ------------------------------------------------------------------ verify: Perch at the original level and at the final level
items2 = {}
for n, d in D.items():
    items2[f"{n}__origF"] = final[f"{n}__orig"]
    for cand in CANDS:
        items2[f"{n}__v_{cand}"] = fade(variants[n][cand]) / d["scale"]     # like-for-like: same level the model saw originally
        items2[f"{n}__f_{cand}"] = final[f"{n}__{cand}"]                    # what Nitin hears
print("Perch on", len(items2), "variant arrays ...", flush=True)
t0 = time.time()
w2 = bsnd.perch_windows(items2, overlap=4.5)
print("perch", round(time.time() - t0, 1), "s", flush=True)
json.dump({"w1": {k: v for k, v in w1.items()}, "w2": {k: v for k, v in w2.items()}}, open(RES / "seg_perch_windows.json", "w"))

# ------------------------------------------------------------------ metrics
def band_levels(sig, f, loud, quiet):
    P_ = np.abs(dsp._stft(sig)[2]) ** 2
    e_ = dsp.band_ms_db(P_, f, dsp.LOW_HZ, 11000)
    ld = np.pad(loud, (0, max(0, len(e_) - len(loud))))[: len(e_)]
    qt = np.pad(quiet, (0, max(0, len(e_) - len(quiet))))[: len(e_)]
    return (10 * np.log10(np.mean(10 ** (e_[ld] / 10)) + 1e-30), 10 * np.log10(np.mean(10 ** (e_[qt] / 10)) + 1e-30))


rows = []
for n, d in D.items():
    sci = d["sci"]
    f, loud, quiet = dsp.frame_sets(final[f"{n}__orig"])
    base_l, base_q = band_levels(d["x"], f, loud, quiet)
    perch_orig_raw = sel[n]["orig_raw"]
    perch_orig_final = best_conf(w2[f"{n}__origF"], sci)
    m0 = dsp.clarity_metrics(final[f"{n}__orig"], loud, quiet)
    rows.append({"name": n, "species": d["c"]["species"], "sci": sci, "camera": d["c"]["camera"], "cand": "orig",
                 "seg_start": d["sg"]["seg_start"], "seg_end": d["sg"]["seg_end"], "perch_raw_level": perch_orig_raw, "perch_final": perch_orig_final,
                 "lufs_out": norm[f"{n}__orig"]["lufs_out"], "max_gr_db": norm[f"{n}__orig"]["max_gr_db"], **m0})
    for cand in CANDS:
        pr = best_conf(w2[f"{n}__v_{cand}"], sci)
        pf = best_conf(w2[f"{n}__f_{cand}"], sci)
        top_sp, top_c = top_any(w2[f"{n}__f_{cand}"])
        m = dsp.clarity_metrics(final[f"{n}__{cand}"], loud, quiet)
        pre = np.load(CAND / f"{n}__{cand}__pre.npy")
        l_, q_ = band_levels(pre, f, loud, quiet)
        ni = norm[f"{n}__{cand}"]
        rows.append({"name": n, "species": d["c"]["species"], "sci": sci, "camera": d["c"]["camera"], "cand": cand,
                     "seg_start": d["sg"]["seg_start"], "seg_end": d["sg"]["seg_end"],
                     "perch_raw_level": pr, "perch_final": pf, "perch_orig_raw": perch_orig_raw, "perch_orig_final": perch_orig_final,
                     "lowered_vs_orig_raw": bool(pr < perch_orig_raw - 0.02), "lowered_vs_orig_final": bool(pf < perch_orig_final - 0.02),
                     "perch_top_final": top_sp, "perch_top_final_conf": top_c,
                     "lufs_out": ni["lufs_out"], "max_gr_db": ni["max_gr_db"], "norm_note": ni["note"],
                     "loud_retention_db": float(l_ - base_l), "quiet_suppression_db": float(base_q - q_), **m})
json.dump(rows, open(RES / "seg_metrics.json", "w"), indent=1)
json.dump({"gpu": gpu_t, "cpu": timing_cpu, "gpu4_summary": {k: v for k, v in t4.items() if k != "per_clip"}, "gpu8_summary": {k: v for k, v in t8.items() if k != "per_clip"}}, open(RES / "seg_timing.json", "w"), indent=1)
print("wrote", len(rows), "rows", flush=True)
