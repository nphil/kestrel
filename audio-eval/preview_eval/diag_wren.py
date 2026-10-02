import sys, json, numpy as np
sys.path.insert(0,'/tmp/bsnd/lib')
import bsnd
C = bsnd.WORK/'seg_cand'
n='Carolina_Wren_8c72c7'
sci=bsnd.SCI['Carolina Wren']
items={}
for c in ('orig','G15','M4'):
    f = C/f'{n}__{c}__raw.npy' if c=='orig' else C/f'{n}__{c}__pre.npy'
    items[f'{n}__{c}']=np.load(f)
w=bsnd.perch_windows(items, overlap=4.5)
for k,rows in w.items():
    print(k, 'len', len(items[k])/bsnd.SR, 'peak', 20*np.log10(np.abs(items[k]).max()+1e-12))
    by={}
    for r in rows:
        by.setdefault(round(r['start'],1),[]).append((r['conf'],r['sci']))
    for st in sorted(by):
        top=sorted(by[st],reverse=True)[:3]
        print('   ',st,[ (round(c,2),s[:22]) for c,s in top])
