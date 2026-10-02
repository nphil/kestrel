import sys, json, numpy as np
sys.path.insert(0,'/tmp/bsnd/lib')
import bsnd
RES=bsnd.ROOT/'results'
segs=json.load(open(RES/'segments.json'))
clips=bsnd.picked()
items={c['name']: bsnd.load_raw(c['name']) for c in clips}
w=bsnd.birdnet_windows(items, overlap=1.5)
out={}
for c in clips:
    n=c['name']; sci=bsnd.SCI[c['species']]
    rows=[r for r in w[n] if r['sci']==sci]
    best=max(rows,key=lambda r:r['conf']) if rows else None
    allr=sorted([(r['start'],r['conf']) for r in rows])
    top_any=max(w[n],key=lambda r:r['conf']) if w[n] else None
    out[n]={'bn_best_start':best['start'] if best else None,'bn_best_end':best['end'] if best else None,'bn_best_conf':best['conf'] if best else 0.0,
            'bn_windows':allr,'bn_top_any':(top_any['sci'],top_any['conf']) if top_any else None,'bnetgo_score':c['score']}
json.dump(out,open(RES/'bn_clip_windows.json','w'),indent=1)
for c in clips:
    n=c['name']; o=out[n]; s=segs[n]
    hi=[round(st,1) for st,cf in o['bn_windows'] if cf>=max(0.5*o['bn_best_conf'],0.05)]
    print(f"{n:30s} bnetgo {o['bnetgo_score']:.2f} | BirdNET best {o['bn_best_start']}-{o['bn_best_end']} conf {o['bn_best_conf']:.2f} | Perch best {s['best_start']}-{s['best_start']+5:.1f} seg {s['seg_start']}-{s['seg_end']} | BN windows>=half-best {hi}")
