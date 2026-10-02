"""Generate candidate scene pull jobs (input for nvr_frames.mjs --jobs) for cameras 88/103/104.

  python scripts/gen_scene_jobs.py 104 --day 48 --dusk 12 --night 48 --seed 1 > data/stage_jobs_104.json

Candidates are spread over the recorded days and the clock (local = UTC-4). A candidate is rejected when an NVR
object event (person/animal/face/package) lies within [-120 s, +60 s] of it, or when it is not inside a stretch of
usable recording (camera 88: only minutes whose recorded segment is > 4 MB, shorter sessions are corrupt h265).
Frames land in data/scenes_stage/<cam>/<T>/{ref,t00..t04}.jpg (ref = first frame of the NVR stream, t00..t04 =
10..14 s later)."""
import argparse, json, os, random, datetime as dt, bisect

ROOT = os.path.join(os.path.dirname(__file__), '..')
ap = argparse.ArgumentParser()
ap.add_argument('cam')
ap.add_argument('--day', type=int, default=0)
ap.add_argument('--dusk', type=int, default=0)
ap.add_argument('--night', type=int, default=0)
ap.add_argument('--seed', type=int, default=1)
ap.add_argument('--min-size', type=int, help='min bytes of a minute file to count as usable (default 4 MB for cam 88, 20 MB otherwise)')
ap.add_argument('--min-gap', type=int, default=240, help='min seconds between candidates')
a = ap.parse_args()
rnd = random.Random(a.seed)

# usable minutes
files = []
for l in open(f'{ROOT}/data/nvr_files_{a.cam}.txt'):
    p, s = l.split()
    files.append((int(p.split('/')[-1][:-5]), int(s)))
files.sort()
thr = a.min_size if a.min_size is not None else (4_000_000 if a.cam == '88' else 20_000_000)
good = [t for t, s in files if s > thr]
start, end = files[0][0] + 120_000, files[-1][0] - 60_000   # keep away from the edges
good_set = set(good)

objs = json.load(open(f'{ROOT}/data/nvr_events/parsed_{a.cam}.json'))['objects']
otimes = sorted(o['t'] for o in objs)

def near_object(T):
    i = bisect.bisect_left(otimes, T - 120_000)
    return i < len(otimes) and otimes[i] <= T + 60_000

def usable(T):
    # the 20 s window T..T+20 s must be covered by good minute files (a file starts every ~60 s)
    ok = [t for t in good if T - 70_000 <= t <= T + 20_000]
    return len(ok) >= 2 and not near_object(T)

def local(T): return dt.datetime.utcfromtimestamp(T / 1000) - dt.timedelta(hours=4)

def period_of(T):
    m = local(T).hour * 60 + local(T).minute
    if 8 * 60 + 15 <= m <= 18 * 60 + 15: return 'day'
    if 6 * 60 + 50 <= m < 8 * 60 + 15 or 18 * 60 + 15 < m <= 19 * 60 + 50: return 'dusk'
    return 'night'

cands = {'day': [], 'dusk': [], 'night': []}
T = start - start % 1000
step = 30_000
while T < end:
    if period_of(T) in cands and usable(T): cands[period_of(T)].append(T)
    T += step
want = {'day': a.day, 'dusk': a.dusk, 'night': a.night}
jobs, chosen = [], []
for per, n in want.items():
    pool = cands[per]
    if not pool or not n: continue
    # stratified: sort by time, cut into n slices and take a random member of each slice
    pool = sorted(pool)
    sl = [pool[i * len(pool) // n:(i + 1) * len(pool) // n] for i in range(n)]
    for s in sl:
        if not s: continue
        for _ in range(20):
            T = rnd.choice(s)
            if all(abs(T - c) > a.min_gap * 1000 for c in chosen): break
        chosen.append(T)
        jobs.append({'cam': a.cam, 't': T, 'out': f'{ROOT}/data/scenes_stage/{a.cam}/{T}',
                     'offsets': [0, 10, 11, 12, 13, 14], 'names': ['ref', 't00', 't01', 't02', 't03', 't04'],
                     'period_guess': per})
jobs.sort(key=lambda j: j['t'])
print(json.dumps(jobs, indent=0))
