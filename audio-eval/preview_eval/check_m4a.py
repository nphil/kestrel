import sys, subprocess, glob, numpy as np, json, os
sys.path.insert(0,'/tmp/bsnd/lib')
import bsnd
res=[]
for f in sorted(glob.glob('/tmp/bsnd/site/audio/*.m4a')):
    p=subprocess.run(['ffmpeg','-v','error','-i',f,'-f','f32le','-ac','1','-ar','22050','-'],capture_output=True)
    y=np.frombuffer(p.stdout,dtype='<f4')
    res.append((os.path.basename(f), len(y)/22050, bsnd.lufs(y), bsnd.true_peak_db(y), float(np.abs(y).max())))
lu=np.array([r[2] for r in res]); tp=np.array([r[3] for r in res]); pk=np.array([r[4] for r in res])
print('files', len(res))
print('LUFS: min %.2f median %.2f max %.2f | within +-0.5 of -16: %d/%d'%(lu.min(),np.median(lu),lu.max(),(np.abs(lu+16)<=0.5).sum(),len(lu)))
print('true peak dBTP after AAC: median %.2f max %.2f | files above -1.0: %d | above -0.5: %d | above 0.0: %d'%(np.median(tp),tp.max(),(tp>-1.0).sum(),(tp>-0.5).sum(),(tp>0.0).sum()))
print('sample peak max %.3f; samples >= 1.0 (clipped): %d files'%(pk.max(), (pk>=0.999).sum()))
bad=[r for r in res if abs(r[2]+16)>0.5 or r[3]>-0.5]
for r in bad[:20]: print('  check', r[0], 'dur %.1f LUFS %.2f TP %.2f'%(r[1],r[2],r[3]))
