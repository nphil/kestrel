#!/usr/bin/env python3
"""Compact comparison tables (markdown) from cached detections.
  python scripts/summary_tables.py --cands a,b,c --modes nvr,oracle --budgets 0,5,20 [--out data/summary.md]
For every candidate x mode and false-alarm budget (empty frames with a false animal per 1000): the lowest score threshold that
stays inside the budget, and recall at that threshold by object size, day/night and bird/mammal. The live setting today is
threshold 0.7 for the baseline model."""
import argparse, json, os, sys
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.join(ROOT, 'lib')); sys.path.insert(0, os.path.dirname(__file__))
from evallib import dataset
import report as R

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cands', required=True); ap.add_argument('--modes', default='nvr,oracle')
    ap.add_argument('--budgets', default='0,5,20'); ap.add_argument('--out')
    ap.add_argument('--fixed', default='', help='extra fixed thresholds to report, e.g. 0.7,0.5')
    ap.add_argument('--thr-from', default='nvr', help='mode whose empty frames set the threshold for each false-alarm budget')
    a = ap.parse_args()
    pairs = dataset.load_all()
    npos = {}
    lines = []
    for mode in a.modes.split(','):
        lines.append(f'\n### mode: {mode}\n')
        lines.append('| candidate | rule | thr | all | <32 | 32-64 | 64-128 | 128-256 | >=256 | day | night/IR | birds | mammals | false alarms /1000 | n pos / n empty |')
        lines.append('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
        for cand in a.cands.split(','):
            dets = R.load_dets(cand, mode)
            if dets is None: continue
            ref_dets = R.load_dets(cand, a.thr_from) or dets
            rules = [(f'FP<={b}/1000', 'b', float(b)) for b in a.budgets.split(',')] + [(f'fixed {t}', 'f', float(t)) for t in a.fixed.split(',') if t]
            for label, kind, val in rules:
                chosen = None
                if kind == 'f':
                    chosen = val
                else:
                    for t in R.THR_GRID:
                        pos, neg = R.evaluate(pairs, ref_dets, t, None, False, a.thr_from)
                        fp = 1000 * R.rate(neg) if neg else 0
                        if fp <= val:
                            chosen = t; break
                    if chosen is None:
                        lines.append(f'| {cand} | {label} | - | (cannot meet budget) |' + ' |' * 11); continue
                pos, neg = R.evaluate(pairs, dets, chosen, None, False, mode)
                bb = R.breakdown(pos, lambda p: p.bucket); bp = R.breakdown(pos, lambda p: 'n' if (p.ir or p.period == 'night') else 'd'); bg = R.breakdown(pos, lambda p: p.gt[0].get('group') or '?')
                g = lambda d, k: (f"{100*d[k]['recall']:.0f}%" if k in d else '-')
                fpv = f'{1000*R.rate(neg):.1f}' if neg else '-'
                lines.append(f"| {cand} | {label} | {chosen:.2f} | {100*R.rate(pos):.0f}% | " + ' | '.join(g(bb, k) for k in ['<32', '32-64', '64-128', '128-256', '>=256']) + f" | {g(bp,'d')} | {g(bp,'n')} | {g(bg,'bird')} | {g(bg,'mammal')} | {fpv} | {len(pos)}/{len(neg)} |")
    txt = '\n'.join(lines)
    print(txt)
    if a.out:
        open(a.out, 'w').write(txt + '\n')

if __name__ == '__main__':
    main()
