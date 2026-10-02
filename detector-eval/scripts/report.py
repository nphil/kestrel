#!/usr/bin/env python3
"""Builds the comparison tables from the cached detections (data/cache/det/*.jsonl).

  python scripts/report.py --cands scrypted_yolov9c_relu_test,mdv6_yolov9c_640 --modes nvr,oracle,full [--json out.json]

For each candidate and mode:
  recall by object size / period / group at the thresholds given, false-alarm frames per 1000 empty frames,
  and recall at fixed false-alarm budgets (0, 5, 20 per 1000), plus the NVR gate pass rate.
"""
import argparse, json, os, sys
from collections import defaultdict
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.join(ROOT, 'lib'))
from evallib import dataset, metrics, boxes as B, zones as Z

THR_GRID = [round(0.10 + 0.05 * i, 2) for i in range(0, 17)]


def load_dets(cand, mode):
    """cand may be a virtual ensemble 'ens:<A>[*gain]+<B>[*gain]...': detections of all parts merged per pair, the score of
    each part multiplied by its gain (clipped to 1) - what the fused ONNX model would report (animal/person/vehicle by max)."""
    if cand.startswith('ens:'):
        out = {}
        for part in cand[4:].split('+'):
            name, _, g = part.partition('*')
            d = load_dets(name, mode)
            if d is None:
                return None
            gain = float(g) if g else 1.0
            for pid, ds in d.items():
                out.setdefault(pid, []).extend({**x, 'score': min(1.0, x['score'] * gain)} for x in ds)
        return out
    p = f'{ROOT}/data/cache/det/{cand}__{mode}.jsonl'
    if not os.path.exists(p):
        return None
    return metrics.collect_by_pair(metrics.load_jsonl(p))


def gate_pass(pair):
    gp = f'{ROOT}/data/cache/gating/' + pair.id.replace('/', '__') + '.json'
    if not os.path.exists(gp):
        return None
    g = json.load(open(gp))
    gt = pair.gt[0]['box']
    for c in g['crops']:
        i = B.inter(c, gt)
        if i and B.area(i) >= 0.7 * B.area(gt):
            return True
    return False


def eligible(p, mode):
    """Is this pair part of the denominator for the mode? (pairs with no crops/detections count as 'nothing found')"""
    if mode.startswith('nvr'):
        d = 'gating' if mode == 'nvr' else 'gating_' + mode[4:]
        return os.path.exists(f'{ROOT}/data/cache/{d}/' + p.id.replace('/', '__') + '.json')
    if mode == 'oracle':
        return bool(p.gt)
    return True


def evaluate(pairs, dets, thr, cfg=None, zone_filter=False, mode=None):
    """-> (positives [(pair, hit)], negatives [(pair, fp)])"""
    pos, neg = [], []
    sizes = {}
    for p in pairs:
        if p.id not in dets and not (mode and eligible(p, mode)):
            continue
        ds = metrics.animal_dets(dets.get(p.id, []), thr)
        if zone_filter and cfg and p.camera in cfg:
            from PIL import Image
            W, H = Image.open(p.test).size
            zs = [z for z in cfg[p.camera]['detection']['zones'] if not z.get('observe')]
            ds = [d for d in ds if Z.object_zone_pass(zs, 'animal', [W, H], d['box'])]
        if p.kind == 'neg':
            neg.append((p, len(ds) > 0))
        elif p.gt:
            pos.append((p, any(metrics.matches(d['box'], g['box']) for d in ds for g in p.gt)))
    return pos, neg


def rate(xs):
    return (sum(1 for _, h in xs if h) / len(xs)) if xs else None


def breakdown(pos, key):
    g = defaultdict(list)
    for p, h in pos:
        g[key(p)].append((p, h))
    return {k: {'n': len(v), 'recall': round(rate(v), 3)} for k, v in sorted(g.items(), key=lambda kv: str(kv[0]))}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cands', required=True)
    ap.add_argument('--modes', default='nvr,oracle,full')
    ap.add_argument('--zone-filter', action='store_true', help='apply each camera\'s object zones (production behaviour)')
    ap.add_argument('--thr', default='0.7,0.5,0.4,0.3')
    ap.add_argument('--json')
    a = ap.parse_args()
    thrs = [float(x) for x in a.thr.split(',')]
    cfg = json.load(open(f'{ROOT}/data/camera-config.json'))
    for c in cfg.values():
        for z in c['detection']['zones']:
            z['exclusion'] = z.get('filterMode') == 'exclude'
            z['observe'] = z.get('filterMode') == 'observe'
    pairs = dataset.load_all()
    out = {}
    for cand in a.cands.split(','):
        for mode in a.modes.split(','):
            dets = load_dets(cand, mode)
            if dets is None:
                continue
            res = {'n_pos': 0, 'n_neg': 0, 'by_thr': {}, 'budget': {}}
            for t in thrs:
                pos, neg = evaluate(pairs, dets, t, cfg, a.zone_filter, mode)
                res['n_pos'], res['n_neg'] = len(pos), len(neg)
                res['by_thr'][t] = {
                    'recall': round(rate(pos), 3) if pos else None,
                    'fp_per_1000': round(1000 * rate(neg), 1) if neg else None,
                    'by_bucket': breakdown(pos, lambda p: p.bucket),
                    'by_period': breakdown(pos, lambda p: 'night/IR' if (p.ir or p.period == 'night') else 'day'),
                    'by_group': breakdown(pos, lambda p: (p.gt[0].get('group') or '?')),
                    'by_camera': breakdown(pos, lambda p: p.camera),
                }
            # recall at fixed false-alarm budgets
            curve = []
            for t in THR_GRID:
                pos, neg = evaluate(pairs, dets, t, cfg, a.zone_filter, mode)
                if pos or neg:
                    curve.append((t, rate(pos), 1000 * rate(neg) if neg else None))
            for budget in (0, 5, 20, 50):
                ok = [c for c in curve if c[2] is not None and c[2] <= budget]
                best = max(ok, key=lambda c: (c[1] or 0)) if ok else None
                res['budget'][budget] = {'thr': best[0], 'recall': round(best[1], 3)} if best and best[1] is not None else None
            out[f'{cand}/{mode}'] = res
    if a.json:
        json.dump(out, open(a.json, 'w'), indent=1)
    for k, r in out.items():
        print(f"== {k}: {r['n_pos']} positives, {r['n_neg']} empty frames")
        for t, v in r['by_thr'].items():
            print(f"  thr {t}: recall {v['recall']} | false-alarm frames/1000 {v['fp_per_1000']} | by size {({b: x['recall'] for b, x in v['by_bucket'].items()})}")
        print('  recall at false-alarm budget/1000:', r['budget'])


if __name__ == '__main__':
    main()
