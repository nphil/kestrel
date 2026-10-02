#!/usr/bin/env python3
"""Person / vehicle recall of each candidate on the regression frames (data/regress, hand-checked NVR events), with GT-box
crops (oracle) and whole frame (full). Class thresholds shown are the NVR defaults (person 0.8, vehicle 0.7) and a looser 0.5.
  python scripts/regress_report.py cand1,cand2 [oracle,full]"""
import json, os, sys
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.join(ROOT, 'lib'))
from evallib import dataset, metrics
pairs = dataset.load_regress()
cands = sys.argv[1].split(','); modes = (sys.argv[2] if len(sys.argv) > 2 else 'oracle,full').split(',')
print(f'{len(pairs)} regress frames, boxes: person {sum(1 for p in pairs for g in p.gt if g["group"]=="person")}, vehicle {sum(1 for p in pairs for g in p.gt if g["group"]=="vehicle")}')
print('| candidate | mode | person@0.8 | person@0.5 | vehicle@0.7 | vehicle@0.5 |'); print('|---|---|---|---|---|---|')
for c in cands:
    for m in modes:
        p_ = f'{ROOT}/data/cache/det/{c}__{m}.jsonl'
        if not os.path.exists(p_): continue
        dets = metrics.collect_by_pair(metrics.load_jsonl(p_))
        res = []
        for cls, thrs in (('person', (0.8, 0.5)), ('vehicle', (0.7, 0.5))):
            for t in thrs:
                n = h = 0
                for p in pairs:
                    for g in p.gt:
                        if g['group'] != cls: continue
                        n += 1
                        h += any(metrics.matches(d['box'], g['box']) for d in metrics.animal_dets(dets.get(p.id, []), t, cls))
                res.append(f'{100*h/n:.0f}% ({h}/{n})' if n else '-')
        print(f'| {c} | {m} | ' + ' | '.join(res) + ' |')
