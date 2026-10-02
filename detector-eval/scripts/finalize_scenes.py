"""Copy reviewed staged scenes into data/scenes/<cam>/<scene_id>/ and (re)write data/scenes/index.jsonl.

  python scripts/finalize_scenes.py 104 103 88

Input per camera: data/scenes_stage/dec_<cam>.txt, tab separated: T status weather tags note  (status ok|rej; '-' = empty).
epoch_ms of a scene = time of t00 = requested T + 6 s (the NVR stream starts ~4 s before the requested time,
ref = first stream frame, t00 = ref + 10 s).  period comes from the local clock (UTC-4): dawn 06:50-07:50 and
dusk 18:45-19:50 -> 'dusk', 07:50-18:45 -> 'day', otherwise 'night'; `ir` from the image chroma (grey = IR)."""
import glob, json, os, shutil, sys, datetime as dt

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.dirname(__file__))
from scene_review import summarize

OFFS = {'ref': 0.0, 't00': 10.0, 't01': 11.0, 't02': 12.0, 't03': 13.0, 't04': 14.0}


def period(epoch_ms):
    loc = dt.datetime.utcfromtimestamp(epoch_ms / 1000) - dt.timedelta(hours=4)
    m = loc.hour * 60 + loc.minute
    if 6 * 60 + 50 <= m < 7 * 60 + 50 or 18 * 60 + 45 <= m < 19 * 60 + 50: return 'dusk'
    if 7 * 60 + 50 <= m < 18 * 60 + 45: return 'day'
    return 'night'


def main(cams):
    idx_path = f'{ROOT}/data/scenes/index.jsonl'
    rows = []
    if os.path.exists(idx_path):
        rows = [json.loads(l) for l in open(idx_path) if l.strip()]
    rows = [r for r in rows if r['camera'] not in cams]
    for cam in cams:
        shutil.rmtree(f'{ROOT}/data/scenes/{cam}', ignore_errors=True)
        for line in open(f'{ROOT}/data/scenes_stage/dec_{cam}.txt'):
            if line.startswith('#') or not line.strip(): continue
            T, status, weather, tags, note = (line.rstrip('\n').split('\t') + ['-'] * 5)[:5]
            if status != 'ok': continue
            src = f'{ROOT}/data/scenes_stage/{cam}/{T}'
            m = summarize(cam, json.load(open(f'{src}/metrics.json')))
            epoch = int(T) + 6000
            sid = f'{cam}_{epoch}'
            dst = f'{ROOT}/data/scenes/{cam}/{sid}'
            os.makedirs(dst)
            for n in OFFS: shutil.copy(f'{src}/{n}.jpg', f'{dst}/{n}.jpg')
            sc = {'camera': cam, 'scene_id': sid, 'source': 'nvr', 'epoch_ms': epoch,
                  'frames': [{'file': f'{n}.jpg', 'dt': d} for n, d in OFFS.items()],
                  'period': period(epoch), 'ir': bool(m['ir']), 'weather': weather,
                  'tags': [] if tags == '-' else tags.split(','), 'size': m['size'], 'animal_present': False,
                  'verified': 'eyes', 'note': '' if note == '-' else note,
                  'motion_area_frac': round(m['motion_area_frac'], 4), 'motion_boxes': m['motion_boxes']}
            json.dump(sc, open(f'{dst}/scene.json', 'w'))
            rows.append(sc)
    rows.sort(key=lambda r: (r['camera'], r['epoch_ms']))
    with open(idx_path, 'w') as f:
        for r in rows: f.write(json.dumps(r) + '\n')
    print(len(rows), 'scenes in index')


if __name__ == '__main__':
    main(sys.argv[1:])
