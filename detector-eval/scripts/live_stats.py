#!/usr/bin/env python3
"""Snapshot of how the live detector pipeline is doing, for before/after comparisons.
  python scripts/live_stats.py --since 6h [--out data/live-stats/<name>.json]
Reads (read-only): Kestrel /health + seen visits, Scrypted container logs (per-camera NVR detection sessions and the
10-second 'Detected (...)' summary lines), nvidia-smi on the host. No Scrypted setting is touched.
"""
import argparse, json, os, re, subprocess, sys, time, urllib.request
from collections import Counter, defaultdict

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
CAMS = ['Backyard Camera', 'Back Door Camera', 'Front Door Camera', 'Bird Camera']


def sh(cmd, timeout=120):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout).stdout


def kestrel(path):
    key = open('/data/home/Kestrel/.kestrel-key').read().strip()
    req = urllib.request.Request('http://192.168.1.69:11080/endpoint/@nphil/kestrel/public/' + path, headers={'X-Kestrel-Key': key})
    return json.load(urllib.request.urlopen(req, timeout=20))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--since', default='6h')
    ap.add_argument('--out')
    a = ap.parse_args()
    out = {'taken_at': time.strftime('%Y-%m-%d %H:%M:%S %Z'), 'since': a.since}
    try:
        out['kestrel_health'] = kestrel('health')
        seen = kestrel('visits?kind=seen&limit=200')['items']
        out['kestrel_seen_visits'] = [{'camera': v['camera']['name'], 'species': v['species'], 'at': v['startedAt'], 'score': v.get('score')} for v in seen]
    except Exception as e:
        out['kestrel_error'] = str(e)
    out['gpu'] = sh('ssh unraid "nvidia-smi --query-gpu=memory.used,memory.total,utilization.gpu,power.draw --format=csv,noheader; nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader"').strip().splitlines()
    logs = sh(f'ssh unraid "docker logs scrypted --since {a.since} 2>&1"', timeout=300)
    sessions = defaultdict(lambda: Counter())
    classes = defaultdict(lambda: defaultdict(list))
    for line in logs.splitlines():
        m = re.match(r'\[([^\]]+)\] (Motion detections|Object detections|Detections saved): (\d+)', line)
        if m and m.group(1) in CAMS:
            sessions[m.group(1)][m.group(2)] += int(m.group(3))
            if m.group(2) == 'Detections saved':
                sessions[m.group(1)]['sessions'] += 1
            continue
        m = re.match(r'\[([^\]]+)\] \[[\d.]+s\] Detected \((moving|stationary|filtered)\)\s*: (.*)', line)
        if m and m.group(1) in CAMS:
            for cls, score in re.findall(r'([a-z_]+) \(([\d.]+)\)', m.group(3)):
                if cls != 'motion':
                    classes[m.group(1)][f'{m.group(2)}:{cls}'].append(float(score))
    out['sessions'] = {k: dict(v) for k, v in sessions.items()}
    out['detected_lines'] = {cam: {k: {'n': len(v), 'max': round(max(v), 3), 'min': round(min(v), 3)} for k, v in d.items()} for cam, d in classes.items()}
    out['onnx_errors'] = [l[:200] for l in logs.splitlines() if re.search(r'(Traceback|error|Error)', l) and 'onnx' in l.lower()][:10]
    print(json.dumps(out, indent=1))
    if a.out:
        os.makedirs(os.path.dirname(a.out), exist_ok=True)
        json.dump(out, open(a.out, 'w'), indent=1)


if __name__ == '__main__':
    main()
