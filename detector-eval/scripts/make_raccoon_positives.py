"""Cut full-res raccoon frames from the Kestrel clip (visit 43030c7c, camera 104) into data/positives_real/.

Boxes are proposed from |frame - background| (background = last frame of the clip, raccoon gone), then reviewed by eye on
annotated copies written to /tmp/rc_ann (adjust BOX_OVERRIDE if a box is wrong).
  python scripts/make_raccoon_positives.py
"""
import json, os, cv2, numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
CLIP = f'{ROOT}/data/truth/raccoon_clip.mp4'
OUT = f'{ROOT}/data/positives_real'
ANN = '/tmp/rc_ann'
os.makedirs(OUT, exist_ok=True); os.makedirs(ANN, exist_ok=True)
T0 = 1790844310000          # overlay of frame 0 reads 04:45:10 EDT = 08:45:10 UTC
FRAMES = [4, 12, 16, 20, 24, 28, 32, 40, 48, 56, 64, 72]   # after n=72 the animal is behind the rail / pillar
BOX_OVERRIDE = {4: [450, 2500, 300, 60], 64: [985, 2150, 170, 190], 72: [945, 2155, 120, 185]}   # hand-set where the diff is confused by IR exposure drift
CLOCK = (1000, 2430, 920, 130)   # burned-in clock, ignored by the diff

cap = cv2.VideoCapture(CLIP)
frames = {}
n = 0
last = None
while True:
    ok, f = cap.read()
    if not ok: break
    if n in FRAMES: frames[n] = f
    last = f; n += 1
bg = last
bgg = cv2.GaussianBlur(cv2.cvtColor(bg, cv2.COLOR_BGR2GRAY), (0, 0), 3).astype(np.int16)
os.makedirs(f'{OUT}/refs', exist_ok=True)
cv2.imwrite(f'{OUT}/refs/raccoon_clip_ref.jpg', bg, [cv2.IMWRITE_JPEG_QUALITY, 95])

def propose(f):
    g = cv2.GaussianBlur(cv2.cvtColor(f, cv2.COLOR_BGR2GRAY), (0, 0), 3).astype(np.int16)
    d = (np.abs(g - bgg) > 22).astype(np.uint8)
    d[CLOCK[1]:CLOCK[1] + CLOCK[3], CLOCK[0]:CLOCK[0] + CLOCK[2]] = 0
    d = cv2.morphologyEx(d, cv2.MORPH_CLOSE, np.ones((25, 25), np.uint8))
    d = cv2.morphologyEx(d, cv2.MORPH_OPEN, np.ones((9, 9), np.uint8))
    cnt, lab, st, _ = cv2.connectedComponentsWithStats(d)
    if cnt < 2: return None
    i = 1 + int(np.argmax(st[1:, cv2.CC_STAT_AREA]))
    x, y, w, h = st[i, :4]
    return [int(x), int(y), int(w), int(h)]

index = []
for n in FRAMES:
    f = frames[n]
    box = BOX_OVERRIDE.get(n) or propose(f)
    pid = f'raccoon_clip_n{n:03d}'
    cv2.imwrite(f'{OUT}/{pid}.jpg', f, [cv2.IMWRITE_JPEG_QUALITY, 95])
    meta = {'camera': '104', 'epoch_ms': T0 + n * 50, 'period': 'night', 'ir': True, 'source': 'kestrel-clip-43030c7c',
            'ref': f'{OUT}/refs/raccoon_clip_ref.jpg', 'size': [f.shape[1], f.shape[0]],
            'boxes': [{'box': box, 'group': 'mammal', 'species': 'Common Raccoon', 'note': f'clip frame {n}'}] if box else []}
    json.dump(meta, open(f'{OUT}/{pid}.json', 'w'))
    a = f.copy()
    if box: cv2.rectangle(a, (box[0], box[1]), (box[0] + box[2], box[1] + box[3]), (0, 0, 255), 4)
    cv2.imwrite(f'{ANN}/{pid}.jpg', a[1900:2560, 0:1920])
    print(n, box)
