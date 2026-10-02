"""Extra candidates for the matched segments: milder gates + 'relaxed' MixIT (partial cancel). Appends rows to seg_metrics.json. Scratch code."""
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
TARGET, TP = -16.0, -1.0
FADE_MS = 75

segs = json.loads((RES / "segments.json").read_text())
sel = json.loads((RES / "seg_selection.json").read_text())
rows = json.loads((RES / "seg_metrics.json").read_text())
clips = bsnd.picked()

NEW_G = {"G04": -4.0, "G07": -7.0, "G10": -10.0}
NEW_MR = {"MR4_50": ("a", 0.5), "MR4_25": ("a", 0.25), "MR4_12": ("a", 0.125),
          "MR8_50": ("b", 0.5), "MR8_25": ("b", 0.25), "MR8_12": ("b", 0.125)}
NEWC = list(NEW_G) + list(NEW_MR)


def fade(y, ms=FADE_MS):
    n = int(ms * 1e-3 * SR)
    w = 0.5 - 0.5 * np.cos(np.pi * np.arange(n) / n)
    y = y.astype(np.float32).copy()
    y[:n] *= w
    y[-n:] *= w[::-1]
    return y


def best_conf(rws, sci):
    v = [r["conf"] for r in rws if r["sci"] == sci]
    return max(v) if v else 0.0


def top_any(rws):
    if not rws:
        return "-", 0.0
    r = max(rws, key=lambda r: r["conf"])
    return r["sci"], r["conf"]


def band_levels(sig, f, loud, quiet):
    P_ = np.abs(dsp._stft(sig)[2]) ** 2
    e_ = dsp.band_ms_db(P_, f, dsp.LOW_HZ, 11000)
    ld = np.pad(loud, (0, max(0, len(e_) - len(loud))))[: len(e_)]
    qt = np.pad(quiet, (0, max(0, len(e_) - len(quiet))))[: len(e_)]
    return (10 * np.log10(np.mean(10 ** (e_[ld] / 10)) + 1e-30), 10 * np.log10(np.mean(10 ** (e_[qt] / 10)) + 1e-30))


D, variants, timing = {}, {}, {}
for c in clips:
    n = c["name"]
    sg = segs[n]
    raw = bsnd.load_raw(n)
    i0, i1 = int(round(sg["seg_start"] * SR)), int(round(sg["seg_end"] * SR))
    x = raw[i0:i1]
    scale = sg["seg_scale"]
    D[n] = {"c": c, "raw": raw, "x": x, "scale": scale, "xs": x * scale, "sci": bsnd.SCI[c["species"]],
            "src": {"a": np.stack([np.load(W / "seg_src4" / f"{n}__s{k}.npy") for k in range(4)]),
                    "b": np.stack([np.load(W / "seg_src8" / f"{n}__s{k}.npy") for k in range(8)])}}
    lam_clip = dsp.noise_psd(np.abs(dsp._stft(raw * scale)[2]) ** 2)
    v, t = {}, {}
    for cid, fl in NEW_G.items():
        t0 = time.perf_counter()
        v[cid] = dsp.wiener_dd(D[n]["xs"], floor_db=fl, lam=lam_clip)
        t[cid] = time.perf_counter() - t0
    for cid, (tag, beta) in NEW_MR.items():
        K = D[n]["src"][tag].shape[0]
        passing = sel[n][tag]["passing"]
        rest = [k for k in range(K) if k not in passing]
        t0 = time.perf_counter()
        y = D[n]["src"][tag][passing].sum(axis=0)
        if rest:
            y = y + beta * D[n]["src"][tag][rest].sum(axis=0)
        v[cid] = y
        t[cid] = time.perf_counter() - t0
    variants[n], timing[n] = v, t

final, norm = {}, {}
for n, d in D.items():
    for cid in NEWC:
        pre = fade(variants[n][cid])
        y, info = bsnd.normalize(pre, target=TARGET, tp_db=TP)
        final[f"{n}__{cid}"], norm[f"{n}__{cid}"] = y, info
        np.save(CAND / f"{n}__{cid}__final.npy", y)
        np.save(CAND / f"{n}__{cid}__pre.npy", pre / d["scale"])

items = {}
for n, d in D.items():
    for cid in NEWC:
        items[f"{n}__v_{cid}"] = np.load(CAND / f"{n}__{cid}__pre.npy")
        items[f"{n}__f_{cid}"] = final[f"{n}__{cid}"]
print("Perch on", len(items), "arrays ...", flush=True)
t0 = time.time()
w = bsnd.perch_windows(items, overlap=4.5)
print("perch", round(time.time() - t0, 1), "s", flush=True)
json.dump(w, open(RES / "seg_perch_windows_extra.json", "w"))

by = {}
for r in rows:
    by.setdefault(r["name"], {})[r["cand"]] = r
new_rows = []
for n, d in D.items():
    sci = d["sci"]
    orig_final = np.load(CAND / f"{n}__orig__final.npy")
    f, loud, quiet = dsp.frame_sets(orig_final)
    base_l, base_q = band_levels(d["x"], f, loud, quiet)
    o = by[n]["orig"]
    for cid in NEWC:
        pr = best_conf(w[f"{n}__v_{cid}"], sci)
        pf = best_conf(w[f"{n}__f_{cid}"], sci)
        top_sp, top_c = top_any(w[f"{n}__f_{cid}"])
        m = dsp.clarity_metrics(final[f"{n}__{cid}"], loud, quiet)
        pre = np.load(CAND / f"{n}__{cid}__pre.npy")
        l_, q_ = band_levels(pre, f, loud, quiet)
        ni = norm[f"{n}__{cid}"]
        new_rows.append({"name": n, "species": d["c"]["species"], "sci": sci, "camera": d["c"]["camera"], "cand": cid,
                         "seg_start": segs[n]["seg_start"], "seg_end": segs[n]["seg_end"],
                         "perch_raw_level": pr, "perch_final": pf, "perch_orig_raw": o["perch_raw_level"], "perch_orig_final": o["perch_final"],
                         "lowered_vs_orig_raw": bool(pr < o["perch_raw_level"] - 0.02), "lowered_vs_orig_final": bool(pf < o["perch_final"] - 0.02),
                         "perch_top_final": top_sp, "perch_top_final_conf": top_c,
                         "lufs_out": ni["lufs_out"], "max_gr_db": ni["max_gr_db"], "norm_note": ni["note"],
                         "loud_retention_db": float(l_ - base_l), "quiet_suppression_db": float(base_q - q_), **m})
rows = [r for r in rows if r["cand"] not in NEWC] + new_rows
json.dump(rows, open(RES / "seg_metrics.json", "w"), indent=1)
tm = json.loads((RES / "seg_timing.json").read_text())
for n, t in timing.items():
    tm["cpu"].setdefault(n, {}).update(t)
json.dump(tm, open(RES / "seg_timing.json", "w"), indent=1)
print("rows now", len(rows), flush=True)
