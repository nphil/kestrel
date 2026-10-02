#!/usr/bin/env python3
"""Contact sheet of composites for eyeballing realism: each tile is a crop around the pasted animal
(context x4 of its box, at least 240 px) at native resolution, plus an overview tile of the whole frame.

  python scripts/composite_montage.py --index data/composites/index.jsonl --dir data/composites --out /tmp/m.jpg \
      [--filter camera=104] [--n 12] [--cols 4] [--tile 360] [--seed 0]
"""
import argparse
import json
import random
from pathlib import Path

import cv2
import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument("--index", default="data/composites/index.jsonl")
ap.add_argument("--dir", default="data/composites")
ap.add_argument("--out", default="/tmp/montage.jpg")
ap.add_argument("--filter", action="append", default=[], help="key=value on index fields (camera, group, size_bucket, period...)")
ap.add_argument("--n", type=int, default=12)
ap.add_argument("--cols", type=int, default=4)
ap.add_argument("--tile", type=int, default=360)
ap.add_argument("--seed", type=int, default=0)
ap.add_argument("--ids", help="comma list of ids")
ap.add_argument("--boxes", action="store_true", help="draw the ground-truth box")
a = ap.parse_args()

rows = [json.loads(l) for l in open(a.index) if l.strip()]
for f in a.filter:
    k, v = f.split("=")
    rows = [r for r in rows if str(r.get(k)) == v]
if a.ids:
    ids = a.ids.split(",")
    rows = [r for r in rows if r["id"] in ids]
random.Random(a.seed).shuffle(rows)
rows = rows[: a.n]
T = a.tile
tiles = []
for r in rows:
    im = cv2.imread(str(Path(a.dir) / f"{r['id']}.jpg"))
    x, y, w, h = r["box"]
    if a.boxes:
        cv2.rectangle(im, (x, y), (x + w, y + h), (0, 255, 0), 1)
    side = int(max(240, max(w, h) * 4))
    cx, cy = x + w // 2, y + h // 2
    x0 = int(np.clip(cx - side // 2, 0, max(im.shape[1] - side, 0))); y0 = int(np.clip(cy - side // 2, 0, max(im.shape[0] - side, 0)))
    crop = im[y0:y0 + side, x0:x0 + side]
    crop = cv2.resize(crop, (T, int(T * crop.shape[0] / crop.shape[1])), interpolation=cv2.INTER_AREA if side > T else cv2.INTER_LINEAR)
    tile = np.zeros((T, T, 3), np.uint8)
    tile[: crop.shape[0], : crop.shape[1]] = crop[:T]
    cv2.putText(tile, f"{r['id'][-18:]} {r['species'][:16]}", (3, 12), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 255, 255), 1)
    cv2.putText(tile, f"{r['size_px']}px {r['region']} {r['period']}", (3, T - 6), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 255, 255), 1)
    tiles.append(tile)
while len(tiles) % a.cols:
    tiles.append(np.zeros((T, T, 3), np.uint8))
grid = np.vstack([np.hstack(tiles[i:i + a.cols]) for i in range(0, len(tiles), a.cols)])
cv2.imwrite(a.out, grid, [cv2.IMWRITE_JPEG_QUALITY, 88])
print(a.out, grid.shape)
