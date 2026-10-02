import sys, json, numpy as np
sys.path.insert(0,'/tmp/bsnd/lib')
import bsnd
clips={c['name']:c for c in bsnd.picked()}
names=['Spring_Peeper_a96d4b','Fish_Crow_354f99','Eastern_Chipmunk_a4249c','Barred_Owl_b4a502','Carolina_Wren_8c72c7','Great_Horned_Owl_8c912b','Coyote_213579','Eastern_Gray_Squirrel_3b525b']
db=lambda g:10**(g/20)
items={}
for n in names:
    x=bsnd.load_raw(n)
    for g in (0,10,20,30,40):
        items[f'{n}__g{g}']=np.clip(x*db(g),-1,1).astype(np.float32)
    y,_=bsnd.normalize(x,target=-16,tp_db=-1)
    items[f'{n}__lufs16']=y
w=bsnd.birdnet_windows(items, overlap=1.5)
for n in names:
    sci=bsnd.SCI[clips[n]['species']]
    best=lambda k: max([r['conf'] for r in w[k] if r['sci']==sci] or [0.0])
    print(f"{n:28s} bnet-go {clips[n]['score']:.2f} | birda BirdNET by gain:", {g:round(best(f'{n}__g{g}'),2) for g in (0,10,20,30,40)}, ' at -16 LUFS:', round(best(f'{n}__lufs16'),2))
