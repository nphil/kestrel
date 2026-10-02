#!/usr/bin/env python3
"""Build the animal cut-out library (data/cutouts/) for the detector composite generator.

Stages (re-runnable, each skips work already done):
  fetch    query iNaturalist for CC-licensed, research-grade photos of the classifier test-set species
           (plus a few extra yard mammals), download the LARGE photo from the open-data bucket, record
           licence / author / url                -> data/work/raw/*.jpg, data/work/candidates.jsonl
  segment  cut the subject out of every candidate with a salient-object model (BiRefNet / IS-Net, ONNX on
           CPU), run automatic sanity checks, write tight RGBA PNGs           -> data/work/seg/*.png (+ stats)
  sheet    contact sheets of candidates so a human can rate them              -> data/work/sheets/*.jpg
  build    take the ratings in data/work/ratings.json (quality 1-5, 0 = reject), copy rated >=3 cut-outs to
           data/cutouts/<id>.png and write data/cutouts/index.jsonl

Photos stay in data/ (git-ignored): they belong to their observers; licence + author are kept per cut-out.
"""
from __future__ import annotations

import argparse
import io
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
WORK = DATA / "work"
RAW = WORK / "raw"
SEG = WORK / "seg"
SHEETS = WORK / "sheets"
CUT = DATA / "cutouts"
MODELS = DATA / "work_models"
MANIFEST = Path("/data/home/Kestrel/classifier/data/testset/manifest.json")
INAT = "https://api.inaturalist.org/v1/observations"
UA = "wildlife-classifier/1.0 (personal home camera project; evaluation only)"
CC = "cc0,cc-by,cc-by-nc,cc-by-sa,cc-by-nc-sa"
LICENCE_NAME = {"cc0": "CC0", "cc-by": "CC BY", "cc-by-nc": "CC BY-NC", "cc-by-sa": "CC BY-SA",
                "cc-by-nc-sa": "CC BY-NC-SA"}
# yard mammals that are not in the classifier test set but matter for a camera detector
EXTRA = [("Domestic Dog", "Canis familiaris", "Mammals"), ("Striped Skunk", "Mephitis mephitis", "Mammals"),
         ("Bobcat", "Lynx rufus", "Mammals"), ("Fox Squirrel", "Sciurus niger", "Mammals")]
SPECIES_NAME_FIX = {"Canis familiaris": "Canis lupus familiaris"}


def http(url: str, tries: int = 3) -> bytes:
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            return urllib.request.urlopen(req, timeout=60).read()
        except Exception as e:  # noqa: BLE001 - network flake, retry politely
            last = e
            time.sleep(2 * (i + 1))
    raise last


def species_list():
    seen, out = set(), []
    for r in json.loads(MANIFEST.read_text()):
        if r["label"] not in seen:
            seen.add(r["label"])
            out.append((r["label"], r["scientific"], r["group"]))
    for e in EXTRA:
        if e[0] not in seen:
            out.append(e)
    return out


# ---------------------------------------------------------------- fetch
def cmd_fetch(a):
    RAW.mkdir(parents=True, exist_ok=True)
    cand_file = WORK / "candidates.jsonl"
    have = {}
    if cand_file.exists():
        for line in cand_file.read_text().splitlines():
            r = json.loads(line)
            have[r["id"]] = r
    per_species = {}
    for r in have.values():
        per_species[r["species"]] = per_species.get(r["species"], 0) + 1
    out = cand_file.open("a")
    for label, sci, group in species_list():
        if a.only and label not in a.only.split(","):
            continue
        want = a.mammals if group == "Mammals" else a.birds
        if a.add:  # top-up: this many MORE candidates than already downloaded
            want = per_species.get(label, 0) + a.add
        if per_species.get(label, 0) >= want:
            continue
        q = {"taxon_name": SPECIES_NAME_FIX.get(sci, sci), "quality_grade": "research", "photos": "true",
             "d1": "2023-01-01", "photo_license": CC, "order_by": a.order, "per_page": 60, "place_id": 1}
        if a.order == "votes":
            pass
        else:
            q["order"] = "desc"
        for attempt in (0, 1):
            if attempt == 1:  # rare species: relax place/date/grade
                q.pop("place_id"); q.pop("d1"); q["quality_grade"] = "research,needs_id"
            res = json.loads(http(INAT + "?" + urllib.parse.urlencode(q)))["results"]
            time.sleep(1.0)
            got_here = per_species.get(label, 0)
            seen_users = {r["author_id"] for r in have.values() if r["species"] == label}
            for obs in res:
                if got_here >= want:
                    break
                if obs["taxon"]["name"] != SPECIES_NAME_FIX.get(sci, sci) and obs["taxon"]["name"] != sci:
                    continue
                if obs["user"]["id"] in seen_users:
                    continue
                ph = next((p for p in obs["photos"] if p.get("license_code") in CC.split(",")), None)
                if not ph:
                    continue
                dims = ph.get("original_dimensions") or {}
                if max(dims.get("width", 0), dims.get("height", 0)) < a.min_px:
                    continue
                cid = f"{obs['id']}_{ph['id']}"
                if cid in have:
                    continue
                ext = ph["url"].rsplit(".", 1)[-1].split("?")[0]
                urls = [f"https://inaturalist-open-data.s3.amazonaws.com/photos/{ph['id']}/large.{ext}",
                        ph["url"].replace("/square.", "/large.")]
                data = None
                for u in urls:
                    try:
                        data = http(u, tries=2)
                        url = u
                        break
                    except Exception:  # noqa: BLE001
                        continue
                time.sleep(1.0)
                if data is None:
                    continue
                try:
                    im = Image.open(io.BytesIO(data)).convert("RGB")
                except Exception:  # noqa: BLE001
                    continue
                im.save(RAW / f"{cid}.jpg", quality=95)
                rec = {"id": cid, "species": label, "scientific": sci, "group": group.lower()[:-1] if group == "Birds" else "mammal",
                       "obs": obs["id"], "photo": ph["id"], "licence": LICENCE_NAME[ph["license_code"]],
                       "author": ph["attribution"], "author_id": obs["user"]["id"], "obs_url": obs["uri"],
                       "photo_url": url, "orig_size": [dims.get("width"), dims.get("height")],
                       "size": list(im.size)}
                have[cid] = rec
                out.write(json.dumps(rec) + "\n"); out.flush()
                seen_users.add(obs["user"]["id"])
                got_here += 1
            per_species[label] = got_here
            if got_here >= want:
                break
        print(f"{label}: {per_species[label]}", flush=True)


# ---------------------------------------------------------------- segment
class Salient:
    """ONNX salient-object model -> soft alpha. Supports isnet-general-use and birefnet (lite)."""

    def __init__(self, name: str):
        import onnxruntime as ort
        self.name = name
        so = ort.SessionOptions()
        so.intra_op_num_threads = int(os.environ.get("OMP_NUM_THREADS", "4"))
        self.sess = ort.InferenceSession(str(MODELS / f"{name}.onnx"), so, providers=["CPUExecutionProvider"])
        self.inp = self.sess.get_inputs()[0]
        shp = self.inp.shape
        self.size = shp[2] if isinstance(shp[2], int) else 1024

    def __call__(self, im: Image.Image) -> np.ndarray:
        s = self.size
        x = np.asarray(im.convert("RGB").resize((s, s), Image.BILINEAR), np.float32) / 255.0
        if self.name.startswith("isnet"):
            x = x / max(x.max(), 1e-6)
            x = (x - np.array([0.485, 0.456, 0.406], np.float32)) / np.array([1, 1, 1], np.float32)
        else:
            x = (x - np.array([0.485, 0.456, 0.406], np.float32)) / np.array([0.229, 0.224, 0.225], np.float32)
        out = self.sess.run(None, {self.inp.name: x.transpose(2, 0, 1)[None]})[-1 if self.name.startswith("birefnet") else 0]
        m = out[0, 0]
        if self.name.startswith("birefnet"):
            m = 1 / (1 + np.exp(-m))
        else:
            m = (m - m.min()) / max(m.max() - m.min(), 1e-6)
        return np.asarray(Image.fromarray((m * 255).astype(np.uint8)).resize(im.size, Image.BICUBIC), np.float32) / 255.0


def refine_alpha(alpha: np.ndarray):
    """keep the dominant connected blob (+ blobs touching it), fill holes, return (alpha, stats)."""
    import cv2
    from scipy import ndimage as ndi
    hard = alpha > 0.5
    lab, n = ndi.label(hard)
    if n == 0:
        return None, {"reject": "empty"}
    areas = ndi.sum(hard, lab, range(1, n + 1))
    # drop blobs that are small and not near the biggest one's bbox
    big = int(np.argmax(areas)) + 1
    ys, xs = np.where(lab == big)
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    pad = 0.15 * max(x1 - x0, y1 - y0)
    keep = np.zeros_like(hard)
    for i in range(1, n + 1):
        yy, xx = np.where(lab == i)
        if i == big or (areas[i - 1] > 0.02 * areas[big - 1] and xx.min() > x0 - pad and xx.max() < x1 + pad
                        and yy.min() > y0 - pad and yy.max() < y1 + pad):
            keep |= lab == i
    filled = ndi.binary_fill_holes(keep)
    # soft alpha only inside a slightly dilated kept region
    near = cv2.dilate(filled.astype(np.uint8), np.ones((9, 9), np.uint8)) > 0
    a2 = np.where(near, alpha, 0.0)
    a2[filled] = np.maximum(a2[filled], 1.0 * (alpha[filled] > 0.25))
    h, w = alpha.shape
    ys, xs = np.where(filled)
    bw, bh = xs.max() - xs.min() + 1, ys.max() - ys.min() + 1
    edge = 3
    touch = {"l": bool(filled[:, :edge].any()), "r": bool(filled[:, -edge:].any()),
             "t": bool(filled[:edge].any()), "b": bool(filled[-edge:].any())}
    frac = float(filled.mean())
    n_touch = sum(touch.values())
    st = {"frac": round(frac, 3), "bbox": [int(xs.min()), int(ys.min()), int(bw), int(bh)], "touch": touch,
          "solidity": round(float(filled.sum() / (bw * bh)), 3),
          "mean_alpha_edge": round(float(((alpha > 0.1) & (alpha < 0.9) & near).sum() / max(filled.sum(), 1)), 4)}
    reject = None
    if frac < 0.015: reject = "too_small"
    elif frac > 0.85: reject = "whole_frame"
    elif n_touch >= 3: reject = "cropped_by_frame"
    st["reject"] = reject
    return a2, st


def cmd_segment(a):
    SEG.mkdir(parents=True, exist_ok=True)
    model = Salient(a.model)
    cands = [json.loads(l) for l in (WORK / "candidates.jsonl").read_text().splitlines()]
    statf = WORK / "seg_stats.json"
    stats = json.loads(statf.read_text()) if statf.exists() else {}
    t0 = time.time()
    for i, r in enumerate(cands):
        key = r["id"]
        if key in stats and stats[key].get("model") == a.model and (SEG / f"{key}.png").exists() or (
                key in stats and stats[key].get("reject") and stats[key].get("model") == a.model):
            continue
        im = Image.open(RAW / f"{key}.jpg").convert("RGB")
        alpha = model(im)
        a2, st = refine_alpha(alpha)
        st["model"] = a.model
        if a2 is not None:
            bx, by, bw, bh = st["bbox"]
            pad = 4
            x0, y0 = max(bx - pad, 0), max(by - pad, 0)
            x1, y1 = min(bx + bw + pad, im.width), min(by + bh + pad, im.height)
            rgba = np.dstack([np.asarray(im), (a2 * 255).astype(np.uint8)])[y0:y1, x0:x1]
            Image.fromarray(rgba, "RGBA").save(SEG / f"{key}.png", optimize=False)
            st["png_size"] = [int(x1 - x0), int(y1 - y0)]
        stats[key] = st
        if (i + 1) % 20 == 0:
            statf.write_text(json.dumps(stats))
            print(f"{i+1}/{len(cands)}  {time.time()-t0:.0f}s", flush=True)
    statf.write_text(json.dumps(stats))
    rej = sum(1 for s in stats.values() if s.get("reject"))
    print(f"segmented {len(stats)}, auto-rejected {rej}")


# ---------------------------------------------------------------- sheets
def checker(w, h, s=8):
    yy, xx = np.mgrid[0:h, 0:w]
    return np.where(((yy // s + xx // s) % 2)[..., None] == 0, np.uint8(200), np.uint8(140)).repeat(3, 2)


def cmd_sheet(a):
    SHEETS.mkdir(parents=True, exist_ok=True)
    cands = [json.loads(l) for l in (WORK / "candidates.jsonl").read_text().splitlines()]
    stats = json.loads((WORK / "seg_stats.json").read_text())
    cands = [c for c in cands if c["id"] in stats and (SEG / f"{c['id']}.png").exists()]
    if a.only_unrated:
        rated = json.loads((WORK / "ratings.json").read_text()) if (WORK / "ratings.json").exists() else {}
        cands = [c for c in cands if c["id"] not in rated]
    if a.skip_rejected:
        cands = [c for c in cands if not stats[c["id"]].get("reject")]
    if a.species:
        cands = [c for c in cands if c["species"] == a.species]
    cell, cols, rows = a.cell, a.cols, a.rows
    per = cols * rows
    font = ImageFont.load_default()
    for sheet_i in range(0, len(cands), per):
        chunk = cands[sheet_i:sheet_i + per]
        img = Image.new("RGB", (cols * cell, rows * (cell + 14)), (30, 30, 30))
        d = ImageDraw.Draw(img)
        for k, c in enumerate(chunk):
            x, y = (k % cols) * cell, (k // cols) * (cell + 14)
            rgba = Image.open(SEG / f"{c['id']}.png")
            rgba.thumbnail((cell - 4, cell - 4))
            bg = Image.fromarray(checker(rgba.width, rgba.height))
            bg.paste(rgba, (0, 0), rgba)
            img.paste(bg, (x + 2, y + 14))
            st = stats[c["id"]]
            tag = f"{sheet_i + k}:{c['id'].split('_')[0][-6:]} {c['species'][:14]}" + (" !" + st["reject"][:5] if st.get("reject") else "")
            d.text((x + 2, y + 1), tag, fill=(255, 255, 0) if not st.get("reject") else (255, 120, 120), font=font)
        img.save(SHEETS / f"sheet{a.tag}_{sheet_i // per:03d}.jpg", quality=88)
    (WORK / "sheet_order.json").write_text(json.dumps([c["id"] for c in cands]))
    print(f"{len(cands)} candidates -> {(len(cands) + per - 1) // per} sheets in {SHEETS}")


# ---------------------------------------------------------------- build
def cmd_build(a):
    CUT.mkdir(parents=True, exist_ok=True)
    cands = {json.loads(l)["id"]: json.loads(l) for l in (WORK / "candidates.jsonl").read_text().splitlines()}
    ratings = json.loads((WORK / "ratings.json").read_text())
    rows, n = [], {}
    for cid, q in sorted(ratings.items()):
        pose = "std"
        if isinstance(q, dict):  # {"q": 4, "pose": "fly"}
            pose, q = q.get("pose", "std"), q["q"]
        if q < a.min_quality or cid not in cands or not (SEG / f"{cid}.png").exists():
            continue
        c = cands[cid]
        src = Image.open(SEG / f"{cid}.png")
        if max(src.size) < a.min_side:  # too few pixels to be scaled up convincingly
            continue
        src.save(CUT / f"{cid}.png")
        rows.append({"id": cid, "species": c["species"], "scientific": c["scientific"], "group": c["group"],
                     "source": f"inat:{c['obs']}/{c['photo']}", "url": c["obs_url"], "photo_url": c["photo_url"],
                     "author": c["author"], "licence": c["licence"], "orig_size": c["orig_size"],
                     "mask": f"{json.loads((WORK / 'seg_stats.json').read_text())[cid]['model']}+blob-filter",
                     "quality": q, "pose": pose, "size": list(src.size)})
        n[c["group"]] = n.get(c["group"], 0) + 1
    for f in CUT.glob("*.png"):
        if f.stem not in {r["id"] for r in rows}:
            f.unlink()
    (CUT / "index.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows))
    print(len(rows), "cut-outs", n)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sp = ap.add_subparsers(dest="cmd", required=True)
    p = sp.add_parser("fetch"); p.add_argument("--birds", type=int, default=7); p.add_argument("--mammals", type=int, default=14)
    p.add_argument("--min-px", type=int, default=900); p.add_argument("--order", default="votes", help="votes|created_at|observed_on")
    p.add_argument("--add", type=int, default=0, help="top-up: fetch this many more candidates per species")
    p.add_argument("--only", help="comma separated species labels"); p.set_defaults(f=cmd_fetch)
    p = sp.add_parser("segment"); p.add_argument("--model", default="isnet-general-use"); p.set_defaults(f=cmd_segment)
    p = sp.add_parser("sheet"); p.add_argument("--cell", type=int, default=240); p.add_argument("--cols", type=int, default=6)
    p.add_argument("--rows", type=int, default=5); p.add_argument("--species"); p.add_argument("--only-unrated", action="store_true"); p.add_argument("--tag", default=""); p.add_argument("--skip-rejected", action="store_true")
    p.set_defaults(f=cmd_sheet)
    p = sp.add_parser("build"); p.add_argument("--min-quality", type=int, default=3); p.add_argument("--min-side", type=int, default=200); p.set_defaults(f=cmd_build)
    a = ap.parse_args()
    a.f(a)


if __name__ == "__main__":
    main()
