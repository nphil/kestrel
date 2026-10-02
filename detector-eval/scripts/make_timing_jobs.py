#!/usr/bin/env python3
"""Writes data/cache/jobs/timing_300.jsonl: 300 realistic crop jobs (NVR-style square crops around composite animals,
paths as seen inside the benchmark container: /work/...). Used only for quiet-window latency/VRAM runs."""
import json, os, sys
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.join(ROOT, 'lib'))
from PIL import Image
from evallib import dataset, nvr
jobs = []
for p in dataset.load_composites():
    W, H = Image.open(p.test).size
    for i, c in enumerate(nvr.select_crops([p.gt[0]['box']], (W, H))):
        jobs.append({'key': f'{p.id}|t{i}', 'image': '/work/' + os.path.relpath(p.test, ROOT), 'crop': [int(v) for v in c], 'mode': 'squash'})
    if len(jobs) >= 300:
        break
os.makedirs(f'{ROOT}/data/cache/jobs', exist_ok=True)
open(f'{ROOT}/data/cache/jobs/timing_300.jsonl', 'w').write('\n'.join(json.dumps(j) for j in jobs[:300]) + '\n')
print(len(jobs[:300]), 'jobs')
