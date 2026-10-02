"""Cross-check the displayed preview variants with BirdNET v2.4 (an independent model, the one BirdNET-Go runs). Scratch code."""
from __future__ import annotations

import json
import sys

sys.path.insert(0, "/tmp/bsnd/lib")
import numpy as np

import bsnd

RES = bsnd.ROOT / "results"
CAND = bsnd.WORK / "seg_cand"
picks = json.loads((RES / "seg_picks.json").read_text())
clips = {c["name"]: c for c in bsnd.picked()}

items, wanted = {}, {}
for n, p in picks.items():
    wanted[n] = ["orig"] + sorted({p["C"], p["D"], p["E"], p["auto"]} - {"orig"})
    for cid in wanted[n]:
        f = CAND / (f"{n}__orig__raw.npy" if cid == "orig" else f"{n}__{cid}__pre.npy")
        items[f"{n}__{cid}"] = np.load(f)
print("BirdNET on", len(items), "arrays", flush=True)
w = bsnd.birdnet_windows(items, overlap=1.5)
out = {}
for n in picks:
    sci = bsnd.SCI[clips[n]["species"]]
    out[n] = {}
    for cid in wanted[n]:
        rows = w[f"{n}__{cid}"]
        v = [r["conf"] for r in rows if r["sci"] == sci]
        top = max(rows, key=lambda r: r["conf"]) if rows else None
        out[n][cid] = {"bn_conf": max(v) if v else 0.0, "bn_top": top["sci"] if top else None, "bn_top_conf": top["conf"] if top else 0.0}
json.dump(out, open(RES / "seg_xcheck.json", "w"), indent=1)
miss = [n for n in out if out[n]["orig"]["bn_conf"] <= 0]
print("clips where BirdNET gives the species 0 on the original moment:", len(miss), miss[:10])
for n in sorted(out):
    o = out[n]["orig"]["bn_conf"]
    cells = " ".join(f"{cid}:{out[n][cid]['bn_conf']:.2f}" for cid in out[n] if cid != "orig")
    print(f"{n:30s} bnet-go {clips[n]['score']:.2f}  BirdNET(orig moment) {o:.2f} | {cells}")
