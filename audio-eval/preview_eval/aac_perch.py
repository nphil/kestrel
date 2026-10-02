import sys, subprocess, glob, os, json, numpy as np
sys.path.insert(0,'/tmp/bsnd/lib')
import bsnd
R=bsnd.ROOT/'results'
picks=json.load(open(R/'seg_picks.json')); rows=json.load(open(R/'seg_metrics.json'))
by={}
for r in rows: by.setdefault(r['name'],{})[r['cand']]=r
clips={c['name']:c for c in bsnd.picked()}
items={}
for f in sorted(glob.glob('/tmp/bsnd/site/audio/*__[BCDE].m4a')):
    p=subprocess.run(['ffmpeg','-v','error','-i',f,'-f','f32le','-ac','1','-ar','22050','-'],capture_output=True)
    items[os.path.basename(f)[:-4]]=np.frombuffer(p.stdout,dtype='<f4').copy()
print('Perch on', len(items), 'decoded AAC previews', flush=True)
w=bsnd.perch_windows(items, overlap=4.5)
out={}
for k,rws in w.items():
    n,l=k.split('__'); sci=bsnd.SCI[clips[n]['species']]
    v=[r['conf'] for r in rws if r['sci']==sci]; out.setdefault(n,{})[l]=max(v) if v else 0.0
json.dump(out,open(R/'seg_perch_aac.json','w'),indent=1)
# compare with pre-AAC final-level numbers
d=[]; flips=[]
for n,dd in out.items():
    p=picks[n]
    for l in 'BCDE':
        cid='orig' if l=='B' else p[l]
        pre=by[n][cid]['perch_final']; d.append(dd[l]-pre)
    # auto pick vs B at AAC level
    a=p['auto_letter']
    if a!='B' and dd[a] < dd['B']-0.05: flips.append((n,a,round(dd['B'],2),round(dd[a],2)))
d=np.array(d); print('AAC vs pre-AAC Perch (final level): mean diff %.3f, mean |diff| %.3f, max |diff| %.2f'%(d.mean(),np.abs(d).mean(),np.abs(d).max()))
print('auto picks whose AAC-level Perch is > 0.05 below B (untouched, same level):', flips)
for n in sorted(out):
    p=picks[n]
    if p['auto_letter']!='B': print(f"  {n:26s} AAC-level Perch: B {out[n]['B']:.2f}  pick {p['auto_letter']} {out[n][p['auto_letter']]:.2f}")
