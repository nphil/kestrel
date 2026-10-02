#!/usr/bin/env python3
"""How much does each hard-coded NVR rule cost? Per gate variant: share of positives whose animal lies inside a crop the
detector would be shown (by size bucket), and crops per empty frame (= detector work / false-alarm exposure).
  python scripts/gate_report.py [--json out.json]
"""
import argparse, json, os, sys
from collections import defaultdict
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.join(ROOT, 'lib'))
from evallib import dataset, boxes as B

VARIANTS = [('stock', 'gating'), ('noband', 'gating_noband'), ('nofloor', 'gating_nofloor')]


def covered(g, gt):
    for c in g['crops']:
        i = B.inter(c, gt)
        if i and B.area(i) >= 0.7 * B.area(gt):
            return True
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--json')
    a = ap.parse_args()
    pairs = dataset.load_all()
    out = {}
    for name, d in VARIANTS:
        pos = defaultdict(list)
        crops = []
        per_cam = defaultdict(list)
        for p in pairs:
            gp = f'{ROOT}/data/cache/{d}/' + p.id.replace('/', '__') + '.json'
            if not os.path.exists(gp):
                continue
            g = json.load(open(gp))
            if p.kind == 'neg':
                crops.append(len(g['crops']))
                per_cam[p.camera].append(len(g['crops']))
            elif p.gt:
                ok = covered(g, p.gt[0]['box'])
                pos[p.bucket].append(ok)
                pos['ALL'].append(ok)
                pos['kind:' + p.kind].append(ok)
        out[name] = {'gate_pass': {k: [round(sum(v) / len(v), 3), len(v)] for k, v in sorted(pos.items(), key=lambda kv: str(kv[0]))},
                     'crops_per_empty_frame': round(sum(crops) / len(crops), 2) if crops else None,
                     'empty_frames': len(crops),
                     'frames_with_any_crop': round(sum(1 for c in crops if c) / len(crops), 3) if crops else None}
    print(json.dumps(out, indent=1))
    if a.json:
        json.dump(out, open(a.json, 'w'), indent=1)


if __name__ == '__main__':
    main()
