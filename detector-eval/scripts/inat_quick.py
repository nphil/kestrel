#!/usr/bin/env python3
"""Quick detector check on the classifier's iNaturalist test photos (390 photos x clean/camera/night):
share of photos where the model reports an 'animal' (NVR class) at several score thresholds.
  python scripts/inat_quick.py <model-name> [mode=squash|letterbox] [threads]
"""
import json, os, sys, statistics, collections
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.join(ROOT, 'lib'))
import cv2
from evallib.detect import Detector
from evallib.metrics import nvr_class

name = sys.argv[1]
mode = sys.argv[2] if len(sys.argv) > 2 else 'squash'
threads = int(sys.argv[3]) if len(sys.argv) > 3 else 4
base = '/data/home/Kestrel/classifier/data/testset'
man = json.load(open(f'{base}/manifest.json'))
det = Detector(os.path.join(ROOT, 'models', name), threads=threads)
res = {}
for variant in ('clean', 'camera', 'night'):
    rows = []
    for m in man:
        p = f'{base}/{variant}/{m["file"]}'
        if not os.path.exists(p):
            continue
        im = cv2.cvtColor(cv2.imread(p), cv2.COLOR_BGR2RGB)
        r = det.detect(im, mode, 0.05)
        best = max([d['score'] for d in r if nvr_class(d) == 'animal'], default=0.0)
        rows.append((m['group'], best, m['label']))
    res[variant] = rows
out = {}
for variant, rows in res.items():
    for g in ('Birds', 'Mammals'):
        s = [b for gg, b, _ in rows if gg == g]
        out[f'{variant}/{g}'] = {f'>={t}': round(sum(x >= t for x in s) / len(s), 3) for t in (0.7, 0.5, 0.3, 0.2)}
        out[f'{variant}/{g}']['n'] = len(s)
print(json.dumps({'model': name, 'mode': mode, 'results': out}))
os.makedirs(f'{ROOT}/data/cache/inat', exist_ok=True)
json.dump({'model': name, 'mode': mode, 'rows': res}, open(f'{ROOT}/data/cache/inat/{name}__{mode}.json', 'w'))
