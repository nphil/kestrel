#!/usr/bin/env python3
"""inat_quick.py on the P40 (inside the scrypted container, <= 1 GB). usage: inat_gpu.py <model> [squash|letterbox] [gpu_mem_mb]"""
import json, os, subprocess, sys
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.join(ROOT, 'lib'))
from evallib.metrics import nvr_class
name = sys.argv[1]
mode = sys.argv[2] if len(sys.argv) > 2 else 'squash'
mem = sys.argv[3] if len(sys.argv) > 3 else '1024'
base = '/data/home/Kestrel/classifier/data/testset'
man = json.load(open(f'{base}/manifest.json'))
stage = f'{ROOT}/scripts/gpu_stage.sh'
# stage images once (tiny) + code + model
if not os.path.exists(f'{ROOT}/data/cache/inat_staged'):
    os.makedirs(f'{ROOT}/data/cache', exist_ok=True)
    subprocess.run(f'tar cf - -C /data/home/Kestrel/classifier/data testset | ssh unraid "docker exec -i de-detector bash -c \'mkdir -p /tmp/de && tar xf - -C /tmp/de\'"', shell=True, check=True)
    open(f'{ROOT}/data/cache/inat_staged', 'w').write('1')
subprocess.run([stage, 'put', 'lib/evallib', 'scripts/gpu_batch_detect.py', f'models/{name}'], check=True)
jobs = []
for v in ('clean', 'camera', 'night'):
    for m in man:
        if os.path.exists(f'{base}/{v}/{m["file"]}'):
            jobs.append({'key': f'{v}/{m["file"]}|f', 'image': f'/tmp/de/testset/{v}/{m["file"]}', 'crop': None, 'mode': mode})
jp = f'{ROOT}/data/cache/jobs/inat_{name}.jsonl'
os.makedirs(os.path.dirname(jp), exist_ok=True)
open(jp, 'w').write('\n'.join(json.dumps(j) for j in jobs) + '\n')
RUN = f'/tmp/de/run_dh_{name}_{mode}_{os.getpid()}'
subprocess.run(f'cat {jp} | ssh unraid "docker exec -i de-detector bash -c \'mkdir -p {RUN} && cat > {RUN}/jobs.jsonl\'"', shell=True, check=True)
env = dict(os.environ, GPU_MEM_MB=mem)
r = subprocess.run([stage, 'run', '/tmp/de/scripts/gpu_batch_detect.py', f'/tmp/de/models/{name}', f'{RUN}/jobs.jsonl', f'{RUN}/out.jsonl'], env=env, capture_output=True, text=True)
print('timing:', r.stdout.strip(), r.stderr.strip()[-300:])
out = f'{ROOT}/data/cache/inat/{name}__{mode}.gpu.jsonl'
os.makedirs(os.path.dirname(out), exist_ok=True)
subprocess.run([stage, 'get', f'{RUN}/out.jsonl', out], check=True)
subprocess.run(f'ssh unraid "docker exec de-detector rm -rf {RUN}"', shell=True)
rows = [json.loads(l) for l in open(out)]
lab = {m['file']: m for m in man}
res = {}
for v in ('clean', 'camera', 'night'):
    for g in ('Birds', 'Mammals'):
        s = []
        for r in rows:
            vv, f = r['key'].split('|')[0].split('/', 1)
            if vv != v or lab[f]['group'] != g: continue
            s.append(max([d['score'] for d in r['dets'] if nvr_class(d) == 'animal'], default=0.0))
        res[f'{v}/{g}'] = {f'>={t}': round(sum(x >= t for x in s) / len(s), 3) for t in (0.7, 0.5, 0.3, 0.2)}
print(json.dumps({'model': name, 'mode': mode, 'results': res}))
