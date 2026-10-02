"""Encode the listening-page audio (AAC/.m4a) and spectrogram strips, and write site/data.json. Scratch code."""
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
(SITE / "audio").mkdir(parents=True, exist_ok=True)
(SITE / "img").mkdir(parents=True, exist_ok=True)
CAND = bsnd.WORK / "cand"

# page letter -> internal candidate id
PAGE = [("A", "A"), ("B", "B_wiener15"), ("C", "C"), ("D", "D"), ("E", "E")]

metrics = json.loads((bsnd.ROOT / "results" / "metrics.json").read_text())
by = {}
for r in metrics:
    by.setdefault(r["name"], {})[r["cand"]] = r
sel = json.loads((bsnd.ROOT / "results" / "selection.json").read_text())


def encode_m4a(y: np.ndarray, out: pathlib.Path) -> None:
    p = subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(bsnd.SR), "-ac", "1", "-i", "-",
                        "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", str(out)],
                       input=np.clip(y, -1, 1).astype("<f4").tobytes(), capture_output=True)
    if p.returncode != 0:
        raise RuntimeError(p.stderr.decode()[-400:])


def spec_jpg(y: np.ndarray, out: pathlib.Path) -> None:
    fig = plt.figure(figsize=(12, 1.45), dpi=100, facecolor="#120E1A")
    ax = fig.add_axes([0.04, 0.17, 0.955, 0.80], facecolor="#120E1A")
    viz.draw(ax, y)
    ax.set_xlim(0, 15)
    ax.set_xticks([0, 3, 6, 9, 12, 15])
    ax.set_xticklabels(["0", "3", "6", "9", "12", "15 s"], fontsize=7)
    for s in ax.spines.values():
        s.set_visible(False)
    ax.tick_params(colors="#B9B3C9", length=2)
    fig.savefig(out, format="jpg", pil_kwargs={"quality": 80})
    plt.close(fig)


def local_time(ms: int) -> str:
    t = dt.datetime.fromtimestamp(ms / 1000, tz=dt.timezone(dt.timedelta(hours=-4)))  # US Eastern (EDT) wall clock
    return t.strftime("%a %b %-d, %-I:%M %p")


clips = bsnd.picked()
data = []
for c in clips:
    n = c["name"]
    entry = {"name": n, "species": c["species"], "camera": c["camera"], "bnet_score": c["score"], "grp": c.get("grp", ""),
             "when": local_time(c["startedAt"]) if c.get("startedAt") else "", "cands": []}
    for letter, cid in PAGE:
        y = np.load(CAND / f"{n}__{cid}__final.npy")
        encode_m4a(y, SITE / "audio" / f"{n}__{letter}.m4a")
        spec_jpg(y, SITE / "img" / f"{n}__{letter}.jpg")
        m = by[n][cid]
        entry["cands"].append({"letter": letter, "perch": round(m["perch_conf"], 3), "perch_top": m["perch_top"],
                               "contrast": round(m["contrast_hi_db"], 1), "quiet_db": round(m["quiet_level_hi_db"], 1),
                               "supp_db": round(m["quiet_suppression_db"], 1), "lufs": round(m["lufs_out"], 1),
                               "note": m.get("norm_note", "")})
    entry["perch_raw"] = round(by[n]["raw"]["perch_conf"], 3)
    entry["mixit4_pick"] = sel[f"{n}__4"]["sel"]
    entry["mixit8_pick"] = sel[f"{n}__8"]["sel"]
    data.append(entry)
    print("built", n, flush=True)
(SITE / "data.json").write_text(json.dumps(data, indent=1))
print("clips", len(data))
