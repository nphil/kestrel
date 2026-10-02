import sys, json, numpy as np
sys.path.insert(0,'/tmp/bsnd/lib')
import bsnd
C = bsnd.WORK/'seg_cand'
names=['Barred_Owl_aab49d','Blue_Jay_6eccb1','Carolina_Wren_4210b3','Great_Horned_Owl_8c912b','Coyote_213579','Red-shouldered_Hawk_9e6478']
db=lambda g: 10**(g/20)
items={}
sel=json.load(open('results/seg_selection.json'))
for n in names:
    x=np.load(C/f'{n}__orig__raw.npy')
    for g in (0,10,20,30,40):
        items[f'{n}__orig_g{g}']=np.clip(x*db(g),-1,1)
    for cand in ('G15','M4','M4S'):
        v=np.load(C/f'{n}__{cand}__pre.npy')
        for g in (0,20,40):
            items[f'{n}__{cand}_g{g}']=np.clip(v*db(g),-1,1)
w=bsnd.perch_windows(items, overlap=4.5)
for n in names:
    sci=bsnd.SCI[[c for c in bsnd.picked() if c['name']==n][0]['species']]
    best=lambda k: max([r['conf'] for r in w[k] if r['sci']==sci] or [0.0])
    print(n, sci)
    print('   orig  ', {g: round(best(f'{n}__orig_g{g}'),3) for g in (0,10,20,30,40)})
    for cand in ('G15','M4','M4S'):
        print(f'   {cand:5s} ', {g: round(best(f'{n}__{cand}_g{g}'),3) for g in (0,20,40)})
