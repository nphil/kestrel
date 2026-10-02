#!/usr/bin/env python3
"""Turns the low-rate live capture (data/live/<cam>/<date>/<epoch_ms>.jpg, see capture_stream.py) into evaluation
scenes (ref.jpg + t00..t04.jpg + scene.json) in data/scenes/<cam>/<scene_id>/, index in data/scenes/index_<cam>.jsonl.

A dropped capture frame means "nothing changed", so the frame in force at time t is the latest kept frame <= t.
  build_scenes_live.py --cam 106 --every-min 12 --hard 40
"""
import argparse, glob, json, os, sys
from datetime import datetime
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
import cv2, numpy as np

ap = argparse.ArgumentParser()
ap.add_argument('--cam', default='106')
ap.add_argument('--every-min', type=float, default=12.0, help='one scene per N minutes of capture')
ap.add_argument('--hard', type=int, default=40, help='extra scenes at the highest-motion moments')
ap.add_argument('--offsets', default='8,12,16,20,24', help='seconds after ref for t00..t04')
ap.add_argument('--sunrise', default='07:36')
ap.add_argument('--sunset', default='19:13')
a = ap.parse_args()
offsets = [float(x) for x in a.offsets.split(',')]
files = sorted(glob.glob(f'{ROOT}/data/live/{a.cam}/*/*.jpg'))
ts = np.array([int(os.path.basename(f)[:-4]) for f in files])
print(len(files), 'frames', datetime.fromtimestamp(ts[0] / 1000), '->', datetime.fromtimestamp(ts[-1] / 1000))

def frame_at(t):
    i = np.searchsorted(ts, t, side='right') - 1
    return i if i >= 0 else None

def period_of(t):
    d = datetime.fromtimestamp(t / 1000)
    hm = d.hour * 60 + d.minute
    sr = int(a.sunrise[:2]) * 60 + int(a.sunrise[3:]); ss = int(a.sunset[:2]) * 60 + int(a.sunset[3:])
    if sr + 45 <= hm <= ss - 45: return 'day'
    if sr - 45 <= hm < sr + 45 or ss - 45 < hm <= ss + 45: return 'dusk'
    return 'night'

# motion energy per frame pair on a small grey thumbnail
def thumb(f):
    im = cv2.imread(f, cv2.IMREAD_GRAYSCALE)
    return cv2.resize(im, (96, 54), interpolation=cv2.INTER_AREA).astype(np.float32)
th = [thumb(f) for f in files]
energy = np.array([0.0] + [float(np.abs(th[i] - th[i - 1]).mean()) for i in range(1, len(th))])

anchors = []
t = ts[0]
while t + (max(offsets) + 2) * 1000 < ts[-1]:
    anchors.append(('regular', int(t)))
    t += a.every_min * 60 * 1000
# hard scenes: top-energy windows that are not near a regular anchor
order = np.argsort(-energy)
taken = [x[1] for x in anchors]
for i in order:
    if len([1 for k, _ in anchors if k == 'hard']) >= a.hard: break
    t0 = int(ts[i] - 10_000)
    if t0 < ts[0] or t0 + (max(offsets) + 2) * 1000 > ts[-1]: continue
    if any(abs(t0 - x) < 60_000 for x in taken): continue
    anchors.append(('hard', t0)); taken.append(t0)

idx_path = f'{ROOT}/data/scenes/index_{a.cam}.jsonl'
os.makedirs(os.path.dirname(idx_path), exist_ok=True)
done = set()
if os.path.exists(idx_path):
    done = {json.loads(l)['scene_id'] for l in open(idx_path) if l.strip()}
n_new = 0
with open(idx_path, 'a') as idx:
    for kind, t0 in anchors:
        sid = f'{a.cam}_{t0}'
        if sid in done: continue
        ri = frame_at(t0)
        tis = [frame_at(t0 + o * 1000) for o in offsets]
        if ri is None or any(i is None for i in tis): continue
        # reject if the reference or test frames are stale (capture gap > 90 s)
        if any(abs((t0 + o * 1000) - ts[i]) > 90_000 for o, i in zip(offsets, tis)) or abs(t0 - ts[ri]) > 90_000: continue
        d = f'{ROOT}/data/scenes/{a.cam}/{sid}'
        os.makedirs(d, exist_ok=True)
        import shutil
        shutil.copyfile(files[ri], f'{d}/ref.jpg')
        frames = [{'file': 'ref.jpg', 'dt': 0.0}]
        for k, (o, i) in enumerate(zip(offsets, tis)):
            shutil.copyfile(files[i], f'{d}/t{k:02d}.jpg')
            frames.append({'file': f't{k:02d}.jpg', 'dt': float((ts[i] - ts[ri]) / 1000)})
        im = cv2.imread(f'{d}/t02.jpg')
        hsv = cv2.cvtColor(im, cv2.COLOR_BGR2HSV)
        ir = bool(hsv[..., 1].mean() < 12)
        e = float(np.mean([energy[i] for i in tis]))
        tags = ['empty'] + (['hard-motion'] if kind == 'hard' else [])
        scene = {'camera': a.cam, 'scene_id': sid, 'source': 'live', 'epoch_ms': int(ts[ri]), 'frames': frames,
                 'period': period_of(t0), 'ir': ir, 'weather': 'unknown', 'tags': tags, 'size': [im.shape[1], im.shape[0]],
                 'animal_present': False, 'verified': 'pending', 'motion_energy': round(e, 2)}
        json.dump(scene, open(f'{d}/scene.json', 'w'))
        idx.write(json.dumps(scene) + '\n')
        n_new += 1
print('new scenes', n_new)
