"""Build a labelled test set that looks like what a home camera actually sends.

Why these photos: both models under test were trained on photos from before 2021
(iNat21 for EVA-02, NABirds for Scrypted's Bird Classifier). Only research-grade
iNaturalist observations made from 2023 onward are used, so neither model can
have seen them.

Why the degradation: Scrypted hands the classifier a crop of the detected animal
out of a compressed security-camera frame, often small and often at night. Each
photo is therefore saved three ways:
  clean  -- the photo as-is (the ceiling)
  camera -- shrunk to <= --crop-px on its longest side and re-encoded at low JPEG
            quality, like a crop out of a 1080p/360p H.264/H.265 stream
  night  -- the camera version in grayscale, like an IR night-vision frame

Photos stay in data/ (git-ignored): they belong to their observers.
"""
from __future__ import annotations

import argparse
import io
import json
import time
import urllib.request
from pathlib import Path

from PIL import Image, ImageFilter

INAT_OBS = "https://api.inaturalist.org/v1/observations"
USER_AGENT = "wildlife-classifier/1.0 (personal home camera project; evaluation only)"


def get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    return urllib.request.urlopen(req, timeout=60).read()


def degrade(img: Image.Image, crop_px: int, quality: int) -> Image.Image:
    img = img.convert("RGB")
    img.thumbnail((crop_px, crop_px), Image.BILINEAR)
    img = img.filter(ImageFilter.GaussianBlur(0.6))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=quality)
    return Image.open(io.BytesIO(buf.getvalue())).convert("RGB")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--species", type=Path, required=True)
    ap.add_argument("--birds", type=int, default=60, help="most-sighted local bird species to test")
    ap.add_argument("--mammals", type=int, default=20, help="most-sighted local mammal species to test")
    ap.add_argument("--per-species", type=int, default=5)
    ap.add_argument("--since", default="2023-01-01")
    ap.add_argument("--crop-px", type=int, default=160)
    ap.add_argument("--quality", type=int, default=35)
    ap.add_argument("--out", type=Path, default=Path("data/testset"))
    args = ap.parse_args()

    rows = json.loads(args.species.read_text())
    chosen = []
    for group, n in (("Birds", args.birds), ("Mammals", args.mammals)):
        chosen += sorted((r for r in rows if r["group"] == group), key=lambda r: -r["local_obs"])[:n]

    manifest = []
    for sp in chosen:
        url = (f"{INAT_OBS}?taxon_name={urllib.request.quote(sp['scientific'])}&quality_grade=research"
               f"&photos=true&d1={args.since}&place_id=1&order_by=votes&per_page={args.per_species * 3}")
        results = json.loads(get(url))["results"]
        time.sleep(1.1)
        got, observers = 0, set()
        for obs in results:
            if got >= args.per_species:
                break
            if obs["taxon"]["name"] != sp["scientific"] or obs["user"]["id"] in observers or not obs["photos"]:
                continue  # one photo per observer: no near-duplicate shots
            observers.add(obs["user"]["id"])
            photo_url = obs["photos"][0]["url"].replace("/square.", "/medium.")
            try:
                img = Image.open(io.BytesIO(get(photo_url))).convert("RGB")
            except Exception as e:  # a dead photo link just means one fewer sample
                print(f"skip {photo_url}: {e}")
                continue
            stem = f"{sp['index']:05d}_{obs['id']}"
            cam = degrade(img, args.crop_px, args.quality)
            variants = {"clean": img, "camera": cam, "night": cam.convert("L").convert("RGB")}
            for name, im in variants.items():
                (args.out / name).mkdir(parents=True, exist_ok=True)
                im.save(args.out / name / f"{stem}.jpg", quality=95)
            manifest.append({"file": f"{stem}.jpg", "index": sp["index"], "label": sp["label"],
                             "scientific": sp["scientific"], "group": sp["group"], "observation": obs["id"]})
            got += 1
            time.sleep(0.5)
        print(f"{sp['label']}: {got}")
    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=1))
    print(f"{len(manifest)} photos x {len(variants)} variants in {args.out}")


if __name__ == "__main__":
    main()
