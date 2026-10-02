#!/usr/bin/env python3
"""Long-running low-rate frame capture from one Scrypted rebroadcast stream.

Pulls ONE rtsp client from the rebroadcast (the prebuffer already exists, so this is
cheap for the camera), decodes it with ffmpeg at 1 frame / --every seconds and writes
JPEGs named by wall-clock epoch milliseconds to data/live/<camera>/<YYYY-MM-DD>/.

Keeps a frame only if it differs from the last kept frame (mean abs diff on a 64x36
thumbnail > --diff) or if --heartbeat seconds passed since the last kept frame (so quiet
scenes are still sampled for the empty-frame set). Reconnects on failure with backoff.

  capture_stream.py --camera 106 --stream mainStream --every 4 --diff 1.2 --heartbeat 300
"""
import argparse, json, os, subprocess, sys, time, io
from datetime import datetime
import numpy as np
from PIL import Image

ap = argparse.ArgumentParser()
ap.add_argument('--camera', required=True)
ap.add_argument('--stream', required=True)
ap.add_argument('--every', type=float, default=4.0)
ap.add_argument('--diff', type=float, default=1.2)
ap.add_argument('--heartbeat', type=float, default=300.0)
ap.add_argument('--quality', type=int, default=3, help='ffmpeg -q:v (2=best..31)')
ap.add_argument('--out', default=os.path.join(os.path.dirname(__file__), '..', 'data', 'live'))
ap.add_argument('--urls', default=os.path.join(os.path.dirname(__file__), '..', 'data', 'rtsp-urls.json'))
args = ap.parse_args()

urls = json.load(open(args.urls))
url = urls[args.camera]['streams'][args.stream]['url'].replace('localhost', '192.168.1.69')
root = os.path.abspath(os.path.join(args.out, args.camera))
os.makedirs(root, exist_ok=True)

def thumb(jpeg_bytes):
    im = Image.open(io.BytesIO(jpeg_bytes)).convert('L').resize((64, 36))
    return np.asarray(im, dtype=np.float32)

def run_once():
    # image2pipe of MJPEG frames: parse SOI/EOI markers from the pipe
    cmd = ['ffmpeg', '-v', 'error', '-rtsp_transport', 'tcp', '-i', url, '-an',
           '-vf', f'fps=1/{args.every}', '-q:v', str(args.quality), '-f', 'image2pipe', '-vcodec', 'mjpeg', '-']
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=1 << 22)
    buf = b''
    last_thumb = None
    last_kept = 0.0
    kept = seen = 0
    while True:
        chunk = p.stdout.read(1 << 16)
        if not chunk:
            break
        buf += chunk
        while True:
            soi = buf.find(b'\xff\xd8')
            if soi < 0:
                buf = b''
                break
            eoi = buf.find(b'\xff\xd9', soi + 2)
            if eoi < 0:
                buf = buf[soi:]
                break
            jpg = buf[soi:eoi + 2]
            buf = buf[eoi + 2:]
            now = time.time()
            seen += 1
            t = thumb(jpg)
            d = 1e9 if last_thumb is None else float(np.abs(t - last_thumb).mean())
            if d > args.diff or now - last_kept >= args.heartbeat:
                day = datetime.fromtimestamp(now).strftime('%Y-%m-%d')
                os.makedirs(f'{root}/{day}', exist_ok=True)
                with open(f'{root}/{day}/{int(now * 1000)}.jpg', 'wb') as f:
                    f.write(jpg)
                last_thumb, last_kept = t, now
                kept += 1
            if seen % 450 == 0:
                print(f'{datetime.now():%H:%M:%S} seen {seen} kept {kept}', flush=True)
    p.wait()
    return seen

backoff = 5
while True:
    try:
        n = run_once()
        backoff = 5 if n > 10 else min(backoff * 2, 120)
    except Exception as e:
        print('error', e, flush=True)
        backoff = min(backoff * 2, 120)
    print(f'{datetime.now():%H:%M:%S} stream ended, reconnect in {backoff}s', flush=True)
    time.sleep(backoff)
