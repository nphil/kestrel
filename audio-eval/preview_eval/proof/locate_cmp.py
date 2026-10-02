"""Throwaway: compare my ORT Perch + pick_segment against the evaluation's (birda) segments for the 27 real clips."""
import json, sys, time
import numpy as np
sys.path.insert(0, '/data/home/kestrel-audio')
from kestrel_audio.codec import decode_file, SR
from kestrel_audio.perch import OrtPerch
from kestrel_audio.locate import pick_segment, window_starts
SCI = {"Eastern Chipmunk":"Tamias striatus","Fish Crow":"Corvus ossifragus","Blue Jay":"Cyanocitta cristata","Tufted Titmouse":"Baeolophus bicolor","Eastern Towhee":"Pipilo erythrophthalmus","Carolina Wren":"Thryothorus ludovicianus","Gray Catbird":"Dumetella carolinensis","Red-bellied Woodpecker":"Melanerpes carolinus","Great Horned Owl":"Bubo virginianus","Barred Owl":"Strix varia","Coyote":"Canis latrans","Spring Peeper":"Pseudacris crucifer","Eastern Screech-Owl":"Megascops asio","Eastern Gray Squirrel":"Sciurus carolinensis","American Bullfrog":"Lithobates catesbeianus","American Robin":"Turdus migratorius","Red-shouldered Hawk":"Buteo lineatus"}
picked = json.load(open('/data/home/Kestrel/audio-eval/data/preview-eval/picked.json'))
segs = json.load(open('/data/home/Kestrel/audio-eval/data/preview-eval/results/segments.json'))
perch = OrtPerch('/data/home/Kestrel/audio-eval/data/preview-eval/models', device='cpu', threads=4, vram_mib=0, batch=8)
out = {}
t0 = time.time()
for c in picked:
    n = c['name']
    x = decode_file(f'/data/home/Kestrel/audio-eval/data/preview-eval/clips/{n}.opus', SR)
    idx = perch.labels.find(SCI[c['species']])
    t = time.time()
    ws = perch.score([x], idx, full_only=True)[0]
    seg = pick_segment(ws.starts, ws.conf, len(x)/SR)
    ev = segs[n]
    out[n] = {'mine': None if seg is None else [seg.start, seg.end, seg.best_start, seg.best_conf], 'eval': [ev['seg_start'], ev['seg_end'], ev['best_start'], ev['best_conf']],
              'curve_mine': ws.conf.tolist(), 'curve_eval': [ev['curve'][str(k)] for k in sorted(float(k) for k in ev['curve'])], 'secs': time.time()-t}
    m = out[n]['mine']; e = out[n]['eval']
    print(f"{n:30s} mine {m[0]:4.1f}-{m[1]:4.1f} best {m[2]:4.1f} ({m[3]:.2f}) | eval {e[0]:4.1f}-{e[1]:4.1f} best {e[2]:4.1f} ({e[3]:.2f})  {out[n]['secs']:.1f}s", flush=True)
json.dump(out, open('/data/home/Kestrel/audio-eval/preview_eval/proof/locate_cmp.json','w'))
print('total', round(time.time()-t0,1), 's')
