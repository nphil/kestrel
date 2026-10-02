"""Metrics + contact sheets for staged scenes (data/scenes_stage/<cam>/<T>/ref,t00..t04.jpg).

  python scripts/scene_review.py metrics 104            # writes <scene>/metrics.json for every staged scene
  python scripts/scene_review.py sheets 104 --per 3 --out /tmp/sheets104 [--ids T1,T2,..]   # PNG contact sheets
Sheet row = ref | t02 (+NVR-style motion boxes vs ref, red=ref->t02, yellow=t02->t04 dt) | t04 | zoomed crops of the 2 largest
moving regions.  These sheets are what the scenes are visually verified with."""
import argparse, glob, json, os, sys, datetime as dt
import numpy as np, cv2
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.join(ROOT, 'lib'))
from evallib.motion import MotionServer, motion_boxes

NAMES = ['ref', 't00', 't01', 't02', 't03', 't04']
# burned-in camera clock / logo rectangles [x,y,w,h] (full-res px); motion boxes touching them are clock digits, not scene motion
OVERLAY = {'103': [[1650, 1830, 910, 90]], '104': [[1000, 2430, 920, 130]], '88': [[0, 0, 440, 110], [40, 985, 640, 80]]}

def clean_boxes(cam, boxes):
    def hit(b, r): return not (b[0] + b[2] < r[0] or r[0] + r[2] < b[0] or b[1] + b[3] < r[1] or r[1] + r[3] < b[1])
    return [b for b in boxes if not any(hit(b, r) for r in OVERLAY.get(cam, []))]

def summarize(cam, m):
    W, H = m['size']
    cb = {k: clean_boxes(cam, v) for k, v in m['boxes'].items()}
    m['cboxes'] = cb
    m['motion_area_frac'] = max(sum(b[2] * b[3] for b in v) / (W * H) for v in cb.values())
    m['motion_boxes'] = max(len(v) for v in cb.values())
    return m

def load(d, n):
    return cv2.cvtColor(cv2.imread(f'{d}/{n}.jpg'), cv2.COLOR_BGR2RGB)

def flat_fraction(img):
    """fraction of 32px blocks that are flat mid-gray or flat green (typical broken-h265 decode)."""
    h, w = img.shape[:2]
    small = cv2.resize(img, (w // 32, h // 32), interpolation=cv2.INTER_AREA).astype(np.int32)
    # flatness: compare block variance on the full-res image
    g = img[: h // 32 * 32, : w // 32 * 32].reshape(h // 32, 32, w // 32, 32, 3).astype(np.float32)
    var = g.var(axis=(1, 3)).mean(axis=-1)
    flat = var < 1.5
    gray = (np.abs(small - 128).max(axis=-1) < 14)
    green = (small[..., 0] < 25) & (small[..., 1] > 100) & (small[..., 1] < 160) & (small[..., 2] < 25)
    return float((flat & (gray | green)).mean())

def scene_metrics(ms, d):
    ref = load(d, 'ref')
    m = {}
    gray = cv2.cvtColor(ref, cv2.COLOR_RGB2GRAY)
    m['brightness'] = float(gray.mean())
    px = ref[::7, ::7].astype(np.int32)
    m['chroma'] = float(np.abs(px[..., 0] - px[..., 1]).mean() + np.abs(px[..., 1] - px[..., 2]).mean())
    m['ir'] = m['chroma'] < 4.0
    m['flat_frac'] = max(flat_fraction(load(d, n)) for n in NAMES)
    area = []; nb = []; boxes = {}
    H, W = ref.shape[:2]
    for n in NAMES[1:]:
        t = load(d, n)
        b, _ = motion_boxes(ms, ref, t)
        boxes[n] = [[round(float(v)) for v in x] for x in b]
        area.append(sum(x[2] * x[3] for x in b) / (W * H)); nb.append(len(b))
    m['motion_area_frac'] = max(area); m['motion_boxes'] = max(nb)
    m['boxes'] = boxes
    t0, t4 = load(d, 't00'), load(d, 't04')
    m['static_diff'] = float(np.abs(t0.astype(np.int16) - t4.astype(np.int16)).mean())
    m['size'] = [W, H]
    return m

def cmd_metrics(a):
    ms = MotionServer()
    for d in sorted(glob.glob(f'{ROOT}/data/scenes_stage/{a.cam}/*/')):
        if not os.path.exists(f'{d}/t04.jpg'): continue
        if os.path.exists(f'{d}/metrics.json') and not a.force: continue
        json.dump(scene_metrics(ms, d.rstrip('/')), open(f'{d}/metrics.json', 'w'))
    ms.close()

FONT = ImageFont.load_default()

def sheet(cam, dirs, out, tw):
    rows = []
    for d in dirs:
        T = os.path.basename(d.rstrip('/'))
        m = summarize(cam, json.load(open(f'{d}/metrics.json')))
        W, H = m['size']; th = int(tw * H / W)
        sc = tw / W
        ref = load(d, 'ref'); t2 = load(d, 't02'); t4 = load(d, 't04')
        def small(im): return cv2.resize(im, (tw, th), interpolation=cv2.INTER_AREA)
        im2 = small(t2).copy()
        bxs = m['cboxes']['t02']
        for b in bxs:
            cv2.rectangle(im2, (int(b[0] * sc), int(b[1] * sc)), (int((b[0] + b[2]) * sc), int((b[1] + b[3]) * sc)), (255, 0, 0), 2)
        # zoom crops of the two largest boxes (from t02), 256 px square each
        crops = []
        allb = sorted(m['cboxes']['t02'] + m['cboxes']['t04'], key=lambda b: -b[2] * b[3])[:2]
        for b in allb:
            cx, cy = b[0] + b[2] / 2, b[1] + b[3] / 2
            s = int(max(b[2], b[3], 96) * 1.3)
            x0, y0 = int(max(0, min(W - s, cx - s / 2))), int(max(0, min(H - s, cy - s / 2)))
            c = t2[y0:y0 + s, x0:x0 + s] if s < min(W, H) else t2
            crops.append(cv2.resize(c, (256, 256), interpolation=cv2.INTER_AREA))
        while len(crops) < 2: crops.append(np.zeros((256, 256, 3), np.uint8))
        crop_col = np.concatenate([np.concatenate(crops[:1], 0), np.concatenate(crops[1:], 0)], 0)
        crop_col = cv2.resize(crop_col, (int(crop_col.shape[1] * th / crop_col.shape[0]), th)) if crop_col.shape[0] != th else crop_col
        row = np.concatenate([small(ref), im2, small(t4), crop_col], 1)
        pil = Image.fromarray(row)
        dr = ImageDraw.Draw(pil)
        loc = dt.datetime.utcfromtimestamp(int(T) / 1000) - dt.timedelta(hours=4)
        label = f'{cam}/{T} {loc:%m-%d %H:%M} bri={m["brightness"]:.0f} ir={int(m["ir"])} mot={m["motion_area_frac"]*100:.1f}% nb={m["motion_boxes"]} flat={m["flat_frac"]:.2f}'
        dr.rectangle([0, 0, 520, 12], fill=(0, 0, 0)); dr.text((2, 0), label, fill=(255, 255, 0), font=FONT)
        rows.append(np.array(pil))
    w = max(r.shape[1] for r in rows)
    rows = [np.pad(r, ((0, 4), (0, w - r.shape[1]), (0, 0))) for r in rows]
    Image.fromarray(np.concatenate(rows, 0)).save(out)

def cmd_sheets(a):
    dirs = sorted(glob.glob(f'{ROOT}/data/scenes_stage/{a.cam}/*/'))
    if a.ids:
        want = set(a.ids.split(',')); dirs = [d for d in dirs if os.path.basename(d.rstrip('/')) in want]
    dirs = [d for d in dirs if os.path.exists(f'{d}/metrics.json')]
    os.makedirs(a.out, exist_ok=True)
    for i in range(0, len(dirs), a.per):
        sheet(a.cam, dirs[i:i + a.per], f'{a.out}/sheet_{a.cam}_{i // a.per:03d}.png', a.tw)
    print(len(dirs), 'scenes ->', (len(dirs) + a.per - 1) // a.per, 'sheets')

def cmd_zoom(a):
    d = f'{ROOT}/data/scenes_stage/{a.cam}/{a.T}'
    x, y, w, h = a.box
    side = max(w, h, 160); x0 = max(0, x + w // 2 - side // 2); y0 = max(0, y + h // 2 - side // 2)
    tiles = []
    for n in NAMES:
        im = load(d, n)[y0:y0 + side, x0:x0 + side]
        tiles.append(cv2.resize(im, (a.px, a.px), interpolation=cv2.INTER_CUBIC))
    Image.fromarray(np.concatenate(tiles, 1)).save(a.out)

if __name__ == '__main__':
    p = argparse.ArgumentParser(); sp = p.add_subparsers(dest='cmd')
    m = sp.add_parser('metrics'); m.add_argument('cam'); m.add_argument('--force', action='store_true')
    s = sp.add_parser('sheets'); s.add_argument('cam'); s.add_argument('--per', type=int, default=3)
    s.add_argument('--out', required=True); s.add_argument('--ids'); s.add_argument('--tw', type=int, default=400)
    z = sp.add_parser('zoom'); z.add_argument('cam'); z.add_argument('T'); z.add_argument('box', type=int, nargs=4); z.add_argument('--out', required=True); z.add_argument('--px', type=int, default=260)
    a = p.parse_args()
    {'metrics': cmd_metrics, 'sheets': cmd_sheets, 'zoom': cmd_zoom}[a.cmd](a)
