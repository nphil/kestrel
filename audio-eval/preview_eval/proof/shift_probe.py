import json, sys, time
import numpy as np
sys.path.insert(0, '/data/home/kestrel-audio')
from kestrel_audio.codec import decode_file, SR, to_perch_rate
from kestrel_audio.perch import OrtPerch
from kestrel_audio.scoring import WINDOW_SAMPLES, to_scores
from kestrel_audio.locate import window_starts
SCI = {"Blue Jay":"Cyanocitta cristata","Great Horned Owl":"Bubo virginianus"}
perch = OrtPerch('/data/home/Kestrel/audio-eval/data/preview-eval/models', device='cpu', threads=4, vram_mib=0, batch=8)
ev = json.load(open('/data/home/Kestrel/audio-eval/data/preview-eval/results/segments.json'))
picked = {c['name']: c for c in json.load(open('/data/home/Kestrel/audio-eval/data/preview-eval/picked.json'))}
for n in ['Blue_Jay_6eccb1', 'Great_Horned_Owl_8c912b']:
    x = decode_file(f'/data/home/Kestrel/audio-eval/data/preview-eval/clips/{n}.opus', SR)
    idx = perch.labels.find(SCI[picked[n]['species']])
    x32 = to_perch_rate(x)
    ref = np.array([ev[n]['curve'][str(k)] for k in sorted(float(k) for k in ev[n]['curve'])])
    starts = window_starts(len(x)/SR, full_only=True)
    for shift in (-1600, -800, 0, 800, 1600):
        y = np.pad(x32, (shift, 0)) if shift > 0 else x32[-shift:]
        W = np.zeros((len(starts), WINDOW_SAMPLES), np.float32)
        for i, s in enumerate(starts):
            a = int(round(s*32000)); seg = y[a:a+WINDOW_SAMPLES]; W[i,:len(seg)] = seg
        c = to_scores(starts, perch.logits(W), idx).conf
        print(f'{n:26s} shift {shift:+5d} smp ({shift/32:+6.1f} ms)  corr {np.corrcoef(c, ref)[0,1]:.3f}  mad {np.abs(c-ref).mean():.3f}  max {np.abs(c-ref).max():.3f}', flush=True)
