// Full-resolution frames from Scrypted NVR recordings at arbitrary past times.
//
//   node scripts/nvr_frames.mjs --cam 104 --t 1790844310000 --out /tmp/x [--offsets 0,10,11,12,13,14]
//                               [--names ref,t00,t01,t02,t03,t04] [--rate 8] [--q 2]
//   node scripts/nvr_frames.mjs --jobs jobs.json        # sequential batch, ONE login
//        jobs.json = [{"cam":"104","t":1790844310000,"out":"dir","offsets":[...],"names":[...]}, ...]
//        (add "--results res.json" to get one result object per job: ok, files, ffmpeg_decode_errors, ms)
//
// How: camera.getRecordingStream({startTime, playbackRate}) returns an RTSP URL served by the NVR.  Without
// `duration` it is a playback stream; with playbackRate=8 it is delivered ~8x faster than real time (a 15 s
// window costs ~2 s) and every frame is present (pts are compressed by the rate; we undo that with
// setpts=PTS*rate).  The stream starts at the last keyframe before startTime, i.e. up to ~2 s earlier
// (plus the camera-vs-NVR clock offset, measured as 3-4 s on 104), and offset 0 = the first frame of the stream.
// Frames are decoded by ffmpeg and written as JPEG with -q:v <q> (1 ~= JPEG quality 95).  Offsets are seconds after
// the first frame (resolution 0.1 s).  Requests are strictly sequential and sleep --gap ms between jobs.
// (`duration` streams and getRecordingStreamThumbnail are NOT used: duration streams stop after ~2.7 s, the
// thumbnail is a q75 JPEG of the nearest keyframe.)
//
// Credentials come from SCRYPTED_USER / SCRYPTED_PASS (source /data/home/Kestrel/.scrypted-cred).
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import { connectScryptedClient } from '@scrypted/client';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];

const baseUrl = process.env.SCRYPTED_URL || 'https://192.168.1.69:10443';
const rate = Number(args.rate || 8);
const quality = String(args.q || 1);
const gapMs = Number(args.gap || 300);
const jobTimeoutMs = Number(args.timeout || 45000);

let jobs;
if (args.jobs) jobs = JSON.parse(fs.readFileSync(args.jobs, 'utf8'));
else {
  if (!args.cam || !args.t || !args.out) {
    console.error('need --cam --t --out (or --jobs)');
    process.exit(2);
  }
  jobs = [{
    cam: args.cam, t: Number(args.t), out: args.out,
    offsets: (args.offsets || '0').split(',').map(Number),
    names: args.names ? args.names.split(',') : undefined,
  }];
}

const realLog = console.log;
console.log = () => {}; // the client prints its auth token while connecting
const sdk = await connectScryptedClient({
  baseUrl, pluginId: '@scrypted/core', username: process.env.SCRYPTED_USER, password: process.env.SCRYPTED_PASS,
});
console.log = realLog;

function runFfmpeg(url, offsets, outPattern, timeoutMs, extraInput = []) {
  const maxOff = Math.max(...offsets);
  const sel = offsets.map((o) => `eq(n\\,${Math.round(o * 10)})`).join('+');
  const vf = `setpts=PTS*${rate},fps=10,select='${sel}'`;
  const a = ['-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', ...extraInput,
    '-t', String((maxOff + 1.5) / rate), '-i', url, '-an', '-vf', vf, '-vsync', 'passthrough',
    '-qmin', '1', '-q:v', quality, '-y', outPattern];
  // -t before -i limits INPUT duration (stream time, i.e. compressed by the rate)
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', a);
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    const to = setTimeout(() => { p.kill('SIGKILL'); err += '\nTIMEOUT'; }, timeoutMs);
    p.on('close', (code) => { clearTimeout(to); resolve({ code, err }); });
  });
}

const results = [];
for (const job of jobs) {
  const t0 = Date.now();
  const offsets = job.offsets || [0];
  const order = offsets.map((o, i) => [o, i]).sort((x, y) => x[0] - y[0]);
  const names = job.names || offsets.map((o) => `f${o}`);
  fs.mkdirSync(job.out, { recursive: true });
  const res = { cam: job.cam, t: job.t, out: job.out, ok: false, files: [] };
  try {
    const dev = sdk.systemManager.getDeviceById(String(job.cam));
    const mo = await dev.getRecordingStream({ startTime: Number(job.t), playbackRate: rate });
    const j = await sdk.mediaManager.convertMediaObjectToJSON(mo, 'x-scrypted/x-ffmpeg-input');
    const tmp = path.join(job.out, `.tmp_${job.t}_%03d.jpg`);
    const { code, err } = await runFfmpeg(j.urls?.[0] || j.url, offsets, tmp, jobTimeoutMs);
    res.ffmpeg_decode_errors = (err.match(/error|corrupt|Invalid|missing|co located/gi) || []).length;
    if (err.includes('TIMEOUT')) res.error = 'ffmpeg timeout';
    const made = fs.readdirSync(job.out).filter((f) => f.startsWith(`.tmp_${job.t}_`)).sort();
    // frames come out in time order; map the i-th to the i-th sorted offset
    if (made.length === offsets.length) {
      made.forEach((f, k) => {
        const name = names[order[k][1]];
        const dst = path.join(job.out, `${name}.jpg`);
        fs.renameSync(path.join(job.out, f), dst);
        res.files.push({ file: `${name}.jpg`, offset: order[k][0] });
      });
      res.ok = true;
    } else {
      res.error = res.error || `got ${made.length}/${offsets.length} frames (ffmpeg code ${code}) ${err.slice(-200)}`;
      made.forEach((f) => fs.unlinkSync(path.join(job.out, f)));
    }
  } catch (e) {
    res.error = String(e.message || e);
  }
  res.ms = Date.now() - t0;
  results.push(res);
  realLog(JSON.stringify({ cam: res.cam, t: res.t, ok: res.ok, ms: res.ms, err: res.error, dec: res.ffmpeg_decode_errors }));
  await new Promise((r) => setTimeout(r, gapMs));
}
if (args.results) fs.writeFileSync(args.results, JSON.stringify(results, null, 1));
sdk.disconnect();
process.exit(results.every((r) => r.ok) ? 0 : 1);
