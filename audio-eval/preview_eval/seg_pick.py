"""Per-clip verified candidate picks + summary tables for the matched-segment run. Scratch code."""
from __future__ import annotations

import collections
import json
import statistics
import sys

sys.path.insert(0, "/tmp/bsnd/lib")
import numpy as np

import bsnd

RES = bsnd.ROOT / "results"
rows = json.loads((RES / "seg_metrics.json").read_text())
by = collections.defaultdict(dict)
for r in rows:
    by[r["name"]][r["cand"]] = r

POOL_G = ["G04", "G07", "G10", "G15", "G20"]
POOL_M = ["M4", "M4S", "M8", "M8S", "MR4_50", "MR4_25", "MR4_12", "MR8_50", "MR8_25", "MR8_12"]
POOL_E = ["M4G", "M4SG", "M8G"]                    # "maximum cleanup" row: AI pick + hiss pass
TOL = 0.02
TOL_FINAL = 0.02                                   # same strict tolerance at the loud level (Perch is level dependent, so this is also checked against the untouched moment made equally loud)
MIN_GAIN_DB = 3.0                                  # not worth processing (or listening to) for less than 3 dB of extra contrast


def ok(r, o):
    """Verified: Perch(species) not lowered (a) like-for-like, i.e. the processed clip scaled back to the original level, and
    (b) on the actual loud -16 LUFS preview, compared with the untouched moment made equally loud; and normalisation clean.
    Perch itself is level dependent (just making the untouched moment louder lowers its score), so (b) uses a looser tolerance."""
    return (r["perch_raw_level"] >= o["perch_raw_level"] - TOL and r["perch_final"] >= o["perch_final"] - TOL_FINAL
            and not r.get("norm_note") and abs(r["lufs_out"] - (-16.0)) < 0.6)


picks = {}
for n, d in by.items():
    o = d["orig"]
    base_contrast = o["contrast_hi_db"]

    def best(pool, fallback=None):
        good = [c for c in pool if c in d and ok(d[c], o)]
        if good:
            return max(good, key=lambda c: d[c]["contrast_hi_db"]), True
        if fallback:
            return fallback, False
        cs = [c for c in pool if c in d and not d[c].get("norm_note")] or [c for c in pool if c in d]
        return max(cs, key=lambda c: d[c]["perch_raw_level"]), False

    c_pick, c_ok = best(POOL_G)
    d_pick, d_ok = best(POOL_M)
    e_pick, e_ok = best(POOL_E, fallback="M4G")
    shown = {"C": c_pick, "D": d_pick, "E": e_pick}
    verified = {k: v for k, v in shown.items() if {"C": c_ok, "D": d_ok, "E": e_ok}[k]}
    auto_letter, gain = "B", 0.0
    if verified:
        k = max(verified, key=lambda k: d[verified[k]]["contrast_hi_db"])
        g = d[verified[k]]["contrast_hi_db"] - base_contrast
        if g >= MIN_GAIN_DB:
            auto_letter, gain = k, g
    picks[n] = {"C": c_pick, "C_ok": c_ok, "D": d_pick, "D_ok": d_ok, "E": e_pick, "E_ok": e_ok,
                "auto_letter": auto_letter, "auto": ("orig" if auto_letter == "B" else shown[auto_letter]), "auto_gain_db": gain}
json.dump(picks, open(RES / "seg_picks.json", "w"), indent=1)

names = sorted(by)
print("clips", len(names))
print("Perch (species) at native level, mean over clips: orig %.3f | at -16 LUFS: orig %.3f" % (
    np.mean([by[n]["orig"]["perch_raw_level"] for n in names]), np.mean([by[n]["orig"]["perch_final"] for n in names])))
cands = POOL_G + ["M4", "M4G", "M4S", "M4SG", "M8", "M8G", "M8S", "MR4_50", "MR4_25", "MR4_12", "MR8_50", "MR8_25", "MR8_12"]
print(f"{'cand':8s} {'like':>6s} {'drop_like':>9s} {'final':>6s} {'drop_fin':>8s} {'supp':>6s} {'ret':>6s} {'contr':>6s} {'verified':>8s} {'norm_ok':>7s}")
for c in cands:
    rr = [by[n][c] for n in names if c in by[n]]
    ver = sum(1 for n in names if c in by[n] and ok(by[n][c], by[n]["orig"]))
    print(f"{c:8s} {np.mean([r['perch_raw_level'] for r in rr]):6.3f} {sum(r['lowered_vs_orig_raw'] for r in rr):6d}/27 {np.mean([r['perch_final'] for r in rr]):6.3f} {sum(r['lowered_vs_orig_final'] for r in rr):5d}/27 "
          f"{np.mean([r['quiet_suppression_db'] for r in rr]):6.1f} {np.mean([r['loud_retention_db'] for r in rr]):6.1f} {np.mean([r['contrast_hi_db'] for r in rr]):6.1f} {ver:5d}/27 {sum(1 for r in rr if not r.get('norm_note')):4d}/27")
print()
cnt = collections.Counter(p["auto"] for p in picks.values())
print("auto picks:", dict(cnt))
proc = [n for n in names if picks[n]["auto"] != "orig"]
print("processed %d/27, untouched %d/27" % (len(proc), 27 - len(proc)))
if proc:
    print("  among processed: mean perch like %.3f (orig %.3f)  mean final %.3f (orig %.3f)  mean contrast gain %.1f dB  mean suppression %.1f dB" % (
        np.mean([by[n][picks[n]["auto"]]["perch_raw_level"] for n in proc]), np.mean([by[n]["orig"]["perch_raw_level"] for n in proc]),
        np.mean([by[n][picks[n]["auto"]]["perch_final"] for n in proc]), np.mean([by[n]["orig"]["perch_final"] for n in proc]),
        np.mean([picks[n]["auto_gain_db"] for n in proc]), np.mean([by[n][picks[n]["auto"]]["quiet_suppression_db"] for n in proc])))
print("C verified %d/27, D verified %d/27, E verified %d/27" % (
    sum(p["C_ok"] for p in picks.values()), sum(p["D_ok"] for p in picks.values()), sum(p["E_ok"] for p in picks.values())))
print()
for n in names:
    o = by[n]["orig"]
    p = picks[n]
    a = by[n][p["auto"]] if p["auto"] != "orig" else o
    print(f"{n:30s} orig {o['perch_raw_level']:.2f}/{o['perch_final']:.2f}  C={p['C']:7s}{'+' if p['C_ok'] else '!'} D={p['D']:7s}{'+' if p['D_ok'] else '!'} E={p['E']:5s}{'+' if p['E_ok'] else '!'} auto={p['auto_letter']}:{p['auto']:7s} gain {p['auto_gain_db']:+.1f} dB  perch {a['perch_raw_level']:.2f}/{a['perch_final']:.2f}")
