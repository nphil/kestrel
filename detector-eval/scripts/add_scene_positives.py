"""Turn frames of a staged scene that contain a real animal into data/positives_real/ entries.

Boxes are proposed from |frame - ref| inside a search window, then must be checked on the annotated copies in /tmp/pos_ann
(override with BOX[...] when needed).  Usage:  python scripts/add_scene_positives.py
Each CONFIG item: camera, stage scene T, frames to keep, search window [x,y,w,h], species, group, ref (stage frame or None)."""
import json, os, cv2, numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
OUT = f'{ROOT}/data/positives_real'
ANN = '/tmp/pos_ann'
os.makedirs(OUT, exist_ok=True); os.makedirs(ANN, exist_ok=True)

CONFIG = [
    dict(cam='104', T='1790773347000', frames=['t00', 't01', 't02', 't03', 't04'], window=[450, 2250, 500, 310],
         species='Eastern Chipmunk', group='mammal', ref='ref', period='day', ir=False, note='chipmunk on porch edge'),
    dict(cam='104', T='1790854467000', frames=['ref', 't00', 't01', 't02', 't03', 't04'], window=[650, 2040, 400, 250],
         species='Eastern Chipmunk', group='mammal', ref='../_pre_45/ref', period='day', ir=False, note='chipmunk on porch steps'),
]
BOX = {}   # (T, frame) -> [x,y,w,h] hand-set boxes


def propose(img, ref, window):
    x, y, w, h = window
    a = cv2.GaussianBlur(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), (0, 0), 2).astype(np.int16)
    b = cv2.GaussianBlur(cv2.cvtColor(ref, cv2.COLOR_BGR2GRAY), (0, 0), 2).astype(np.int16)
    d = (np.abs(a - b) > 28).astype(np.uint8)
    m = np.zeros_like(d); m[y:y + h, x:x + w] = 1
    d *= m
    d = cv2.morphologyEx(d, cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8))
    d = cv2.morphologyEx(d, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    n, lab, st, _ = cv2.connectedComponentsWithStats(d)
    if n < 2: return None
    # union of components bigger than 15% of the largest (animal + tail etc.)
    areas = st[1:, cv2.CC_STAT_AREA]; keep = [i + 1 for i, v in enumerate(areas) if v >= 0.15 * areas.max()]
    x0 = min(st[i, 0] for i in keep); y0 = min(st[i, 1] for i in keep)
    x1 = max(st[i, 0] + st[i, 2] for i in keep); y1 = max(st[i, 1] + st[i, 3] for i in keep)
    return [int(x0), int(y0), int(x1 - x0), int(y1 - y0)]


if __name__ == '__main__':
    index = []
    for c in CONFIG:
        d = f'{ROOT}/data/scenes_stage/{c["cam"]}/{c["T"]}'
        ref = cv2.imread(f'{d}/{c["ref"]}.jpg')
        for fr in c['frames']:
            img = cv2.imread(f'{d}/{fr}.jpg')
            box = BOX.get((c['T'], fr)) or propose(img, ref, c['window'])
            pid = f'{c["cam"]}_{c["T"]}_{fr}'
            cv2.imwrite(f'{OUT}/{pid}.jpg', img, [cv2.IMWRITE_JPEG_QUALITY, 95])
            os.makedirs(f'{OUT}/refs', exist_ok=True)
            refpath = f'{OUT}/refs/{pid}.jpg'
            cv2.imwrite(refpath, ref, [cv2.IMWRITE_JPEG_QUALITY, 95])
            meta = {'camera': c['cam'], 'epoch_ms': int(c['T']) + 6000 + ({'ref': 0, 't00': 10, 't01': 11, 't02': 12, 't03': 13, 't04': 14}[fr] - 10) * 1000,
                    'period': c['period'], 'ir': c['ir'], 'source': 'nvr', 'ref': refpath, 'size': [img.shape[1], img.shape[0]],
                    'boxes': [{'box': box, 'group': c['group'], 'species': c['species'], 'note': c['note']}] if box else []}
            json.dump(meta, open(f'{OUT}/{pid}.json', 'w'))
            a = img.copy()
            if box: cv2.rectangle(a, (box[0], box[1]), (box[0] + box[2], box[1] + box[3]), (0, 0, 255), 3)
            x, y, w, h = c['window']
            cv2.imwrite(f'{ANN}/{pid}.jpg', a[y:y + h, x:x + w])
            print(pid, box)
