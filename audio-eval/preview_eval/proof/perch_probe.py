import json, sys, time
import numpy as np
from scipy.signal import resample_poly
import onnxruntime as ort

labels=[l.strip() for l in open('/data/home/Kestrel/audio-eval/data/preview-eval/models/perch_v2_labels.txt')][1:]   # first line is the dataset id
print('labels', len(labels), labels[:2])
so=ort.SessionOptions(); so.intra_op_num_threads=4
s=ort.InferenceSession('/data/home/Kestrel/audio-eval/data/preview-eval/models/perch_v2_no_dft_fp32.onnx', so, providers=['CPUExecutionProvider'])

def softmax(z):
    z=z-z.max(axis=-1,keepdims=True); e=np.exp(z); return e/e.sum(axis=-1,keepdims=True)

wins=json.load(open('/data/home/Kestrel/audio-eval/data/preview-eval/results/perch_windows.json'))
segs=json.load(open('/data/home/Kestrel/audio-eval/data/preview-eval/results/segments.json'))
SCI={'Barred_Owl_aab49d':'Strix varia','Blue_Jay_6eccb1':'Cyanocitta cristata','Spring_Peeper_a96d4b':'Pseudacris crucifer'}
for name,sci in SCI.items():
    x22=np.load(f'/data/home/Kestrel/audio-eval/data/preview-eval/work/raw22k/{name}.npy').astype(np.float32)
    x32=resample_poly(x22,640,441).astype(np.float32)
    print(name,'len22',len(x22),'len32',len(x32), len(x32)/32000)
    starts=[]; 
    n=len(x32); W=160000; hop=16000
    st=0
    while st < n:
        starts.append(st); st+=hop
    # build windows with zero padding for partial tail
    batch=np.zeros((len(starts),W),np.float32)
    for i,st in enumerate(starts):
        seg=x32[st:st+W]; batch[i,:len(seg)]=seg
    t=time.time()
    out=[]
    for i in range(0,len(batch),8):
        out.append(s.run(['label'],{'inputs':batch[i:i+8]})[0])
    logits=np.concatenate(out); p=softmax(logits.astype(np.float64))
    print('  ort time', round(time.time()-t,2),'s for',len(starts),'windows')
    idx=labels.index(sci)
    mine={round(st/32000,2): float(p[i,idx]) for i,st in enumerate(starts)}
    bird={}
    for r in wins[name]:
        if r['sci']==sci: bird[round(r['start'],2)]=r['conf']
    print('  start | mine | birda')
    for st in sorted(set(mine)|set(bird)):
        print('  %5.1f  %.4f  %.4f'%(st, mine.get(st,float('nan')), bird.get(st,float('nan'))))
    allstarts=sorted({round(r['start'],2) for r in wins[name]})
    print('  birda window starts present:', allstarts)
