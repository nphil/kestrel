#!/usr/bin/env python3
"""What does the Wildlife Classifier (live device 248, read-only inference) do with the crops a detector produces?

  python scripts/clf_eval.py make --cand <cand> --mode <mode> --thr 0.5   -> writes crops + list under data/cache/clf/<tag>/
  python scripts/clf_eval.py make --gt                                    -> crops around the GROUND-TRUTH box (perfect detector)
  (then)  node scripts/classify_crops.mjs data/cache/clf/<tag>/list.txt data/cache/clf/<tag>/out.jsonl
  python scripts/clf_eval.py score --tag <tag>
Crop = what the NVR hands the classifier: the detection box made square around its centre (cc(), aspect 1), cut from the frame.
A label counts as SHOWN when its top score >= 0.7 (the NVR's rule); 'right' compares with the species the cut-out came from.
"""
import argparse, json, os, sys
from collections import defaultdict
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.join(ROOT, 'lib'))
import cv2
from evallib import dataset, metrics, boxes as B


def make(a):
    pairs = [p for p in dataset.load_composites() if p.gt and p.gt[0].get('species')]
    tag = 'gt' if a.gt else f'{a.cand}__{a.mode}__{a.thr}'
    d = f'{ROOT}/data/cache/clf/{tag}'
    os.makedirs(d, exist_ok=True)
    dets = None
    if not a.gt:
        dets = metrics.collect_by_pair(metrics.load_jsonl(f'{ROOT}/data/cache/det/{a.cand}__{a.mode}.jsonl'))
    lst, meta = [], {}
    for p in pairs:
        gt = p.gt[0]['box']
        if a.gt:
            box = gt
        else:
            ds = [x for x in metrics.animal_dets(dets.get(p.id, []), a.thr) if metrics.matches(x['box'], gt)]
            if not ds:
                continue
            box = max(ds, key=lambda x: x['score'])['box']
        im = cv2.imread(p.test)
        H, W = im.shape[:2]
        c = B.fit_aspect([int(v) for v in box], 1.0, [W, H])
        if not c:
            continue
        c = B.inter([0, 0, W, H], B.union(c, [int(v) for v in box]))
        x, y, w, h = [int(v) for v in c]
        if w < 4 or h < 4:
            continue
        fn = f'{d}/{p.id.replace("/", "__")}.jpg'
        cv2.imwrite(fn, im[y:y + h, x:x + w], [cv2.IMWRITE_JPEG_QUALITY, 95])
        lst.append(fn)
        meta[fn] = {'pair': p.id, 'species': p.gt[0]['species'], 'group': p.gt[0].get('group'), 'bucket': p.bucket, 'ir': p.ir or p.period == 'night', 'camera': p.camera}
    open(f'{d}/list.txt', 'w').write('\n'.join(lst))
    json.dump(meta, open(f'{d}/meta.json', 'w'))
    print(tag, len(lst), 'crops of', len(pairs), 'composites ->', d)


def score(a):
    d = f'{ROOT}/data/cache/clf/{a.tag}'
    meta = json.load(open(f'{d}/meta.json'))
    rows = [json.loads(l) for l in open(f'{d}/out.jsonl')]
    n_all = len([p for p in dataset.load_composites() if p.gt and p.gt[0].get('species')])
    by = defaultdict(lambda: {'n': 0, 'shown': 0, 'right_top1': 0, 'shown_right': 0})
    for r in rows:
        m = meta.get(r['path'])
        if not m or r.get('error'):
            continue
        top = (r['detections'] or [{}])[0]
        shown = bool(top) and top.get('score', 0) >= 0.7
        right = bool(top) and top.get('className') == m['species']
        for k in ('ALL', 'bucket:' + str(m['bucket']), 'group:' + str(m['group']), 'night' if m['ir'] else 'day'):
            b = by[k]
            b['n'] += 1; b['shown'] += shown; b['right_top1'] += right; b['shown_right'] += shown and right
    out = {k: {**v, 'shown%': round(100 * v['shown'] / v['n']), 'top1%': round(100 * v['right_top1'] / v['n']), 'shown&right%': round(100 * v['shown_right'] / v['n'])} for k, v in sorted(by.items())}
    out['_crops'] = len(rows); out['_composites_total'] = n_all
    print(json.dumps(out, indent=1))
    json.dump(out, open(f'{d}/score.json', 'w'), indent=1)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('cmd', choices=['make', 'score'])
    ap.add_argument('--cand'); ap.add_argument('--mode'); ap.add_argument('--thr', type=float, default=0.5)
    ap.add_argument('--gt', action='store_true'); ap.add_argument('--tag')
    a = ap.parse_args()
    make(a) if a.cmd == 'make' else score(a)
