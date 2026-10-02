import sys, json, numpy as np
sys.path.insert(0,'/tmp/bsnd/lib')
import bsnd
C = bsnd.WORK/'seg_cand'
rows=json.load(open('results/seg_metrics.json'))
db=lambda g: 10**(g/20)
cases=[('Blue_Jay_da035e','M8G','Cyanocitta cristata'),('Blue_Jay_da035e','orig','Cyanocitta cristata'),('Tufted_Titmouse_bae359','M8G','Baeolophus bicolor'),('Red-bellied_Woodpecker_ae23ce','orig','Melanerpes carolinus'),('Red-bellied_Woodpecker_ae23ce','MR8_25','Melanerpes carolinus')]
items={}
for n,c,_ in cases:
    pre = np.load(C/(f'{n}__orig__raw.npy' if c=='orig' else f'{n}__{c}__pre.npy'))
    fin = np.load(C/f'{n}__{c}__final.npy')
    pk=np.abs(pre).max()
    for g in (0,10,20,30,40,50):
        items[f'{n}__{c}_g{g}']=np.clip(pre*db(g),-1,1).astype(np.float32)
    items[f'{n}__{c}_final']=fin
    print(n,c,'raw peak dBFS %.1f'%(20*np.log10(pk)), 'final peak %.1f'%(20*np.log10(np.abs(fin).max())), 'gain to final %.1f dB'%(20*np.log10(np.abs(fin).max()/pk)))
w=bsnd.perch_windows(items, overlap=4.5)
for n,c,sci in cases:
    best=lambda k: max([r['conf'] for r in w[k] if r['sci']==sci] or [0.0])
    print(n,c,{g:round(best(f'{n}__{c}_g{g}'),2) for g in (0,10,20,30,40,50)}, 'final', round(best(f'{n}__{c}_final'),2))
