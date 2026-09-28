#!/usr/bin/env node
// Capture Scrypted camera rebroadcast audio without ever logging its private RTSP URL.
// From the repository root: set -a; source .scrypted-cred; set +a; node audio-eval/capture_backgrounds.mjs
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdir, stat, writeFile, unlink, readFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, 'data');
const CAMERAS = new Map([
  ['104', 'Front Door Camera'],
  ['103', 'Back Door Camera'],
  ['88', 'Backyard Camera'],
]);

const { values: args } = parseArgs({
  options: {
    cameras: { type: 'string', default: '104,103,88' },
    'duration-seconds': { type: 'string', default: '60' },
    rounds: { type: 'string', default: '3' },
    'gap-seconds': { type: 'string', default: '30' },
    probe: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});
if (args.help) {
  process.stdout.write('Capture rebroadcast microphone audio into git-ignored audio-eval/data.\n');
  process.stdout.write('Options: --cameras 104,103,88 --duration-seconds 60 --rounds 3 --gap-seconds 30 --probe\n');
  process.exit(0);
}
const positiveInt = (name, fallback) => {
  const value = Number(args[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer`);
  return value;
};
const durationSeconds = args.probe ? 8 : positiveInt('duration-seconds', 60);
const rounds = args.probe ? 1 : positiveInt('rounds', 3);
const gapSeconds = args.probe ? 0 : Number(args['gap-seconds'] ?? 30);
if (!Number.isInteger(gapSeconds) || gapSeconds < 0) throw new Error('--gap-seconds must be a non-negative integer');
const cameraIds = [...new Set(args.cameras.split(',').map(x => x.trim()).filter(Boolean))];
if (!cameraIds.length || cameraIds.some(id => !CAMERAS.has(id))) throw new Error('--cameras must contain only 104, 103, and/or 88');
if (!process.env.SCRYPTED_USER || !process.env.SCRYPTED_PASS) throw new Error('Load .scrypted-cred into the environment first');

// The SDK prints its login response (including a short-lived bearer token). Keep its
// console muted for the full connection; only this script's sanitized messages escape.
const originalConsole = Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map(k => [k, console[k]]));
for (const key of Object.keys(originalConsole)) console[key] = () => {};
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // Scrypted uses a self-signed LAN certificate.
let sdk;
const say = message => process.stdout.write(`${message}\n`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function scryptedCommand(script, url, outputPath = null) {
  // The URL travels over SSH stdin rather than in a command line or log.
  const remote = `docker exec -i scrypted sh -c '${script}'`;
  const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'unraid', remote], { stdio: ['pipe', 'pipe', 'ignore'] });
  let stdout = '';
  const closed = new Promise((resolve, reject) => {
    child.once('error', () => reject(new Error('SSH connection to the Scrypted host failed')));
    child.once('close', code => resolve(code ?? 1));
  });
  const outputFlow = outputPath ? pipeline(child.stdout, createWriteStream(outputPath)) : null;
  if (!outputPath) child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stdin.end(url + '\n');
  let code;
  try { code = await closed; }
  catch { throw new Error('SSH connection to the Scrypted host failed'); }
  if (outputFlow) {
    try { await outputFlow; }
    catch { throw new Error('camera audio stream could not be saved'); }
  }
  return { code, stdout };
}

async function inputAudioInfo(url) {
  const transport = url.startsWith('rtsp://') || url.startsWith('rtsps://') ? '-rtsp_transport tcp ' : '';
  const script = `IFS= read -r url; exec ffprobe -v error ${transport}-select_streams a:0 -show_entries stream=codec_name,sample_rate,channels -of json "$url"`;
  try {
    const result = await scryptedCommand(script, url);
    if (result.code !== 0) return null;
    const stream = JSON.parse(result.stdout).streams?.[0];
    return stream ? {
      codec: stream.codec_name ?? null,
      sample_rate: Number(stream.sample_rate) || null,
      channels: Number(stream.channels) || null,
    } : null;
  } catch {
    return null;
  }
}

async function capture(url, output) {
  const transport = url.startsWith('rtsp://') || url.startsWith('rtsps://') ? '-rtsp_transport tcp ' : '';
  const script = 'IFS= read -r url; exec ffmpeg -nostdin -hide_banner -loglevel quiet ' + transport + '-i "$url" -t ' + durationSeconds + ' -vn -ac 1 -ar 16000 -c:a pcm_s16le -f s16le pipe:1';
  const rawOutput = output + '.pcm';
  const result = await scryptedCommand(script, url, rawOutput);
  if (result.code !== 0) {
    await unlink(rawOutput).catch(() => {});
    await unlink(output).catch(() => {});
    throw new Error('Scrypted could not capture the camera audio');
  }
  const pcm = await readFile(rawOutput);
  await unlink(rawOutput).catch(() => {});
  if (pcm.length < 1024 || pcm.length % 2 !== 0) throw new Error('camera stream returned no usable PCM audio');
  const capturedDurationSeconds = pcm.length / (16000 * 2);
  if (capturedDurationSeconds < durationSeconds * 0.95) throw new Error(`camera stream ended early (${capturedDurationSeconds.toFixed(1)}s of ${durationSeconds}s requested)`);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  await writeFile(output, Buffer.concat([header, pcm]));
  const info = await stat(output).catch(() => null);
  if (!info || info.size < 1024) {
    await unlink(output).catch(() => {});
    throw new Error('camera stream returned no usable audio');
  }
  return capturedDurationSeconds;
}

const session = new Date().toISOString().replace(/[-:.]/g, '').replace('T', '_').replace('Z', 'Z');
const outDir = path.join(DATA, 'backgrounds', 'raw', session);
const manifest = [];

try {
  const requireFromDeploy = createRequire(new URL('../classifier/deploy/package.json', import.meta.url));
  const clientEntry = requireFromDeploy.resolve('@scrypted/client');
  const { connectScryptedClient } = await import(pathToFileURL(clientEntry).href);
  sdk = await connectScryptedClient({
    baseUrl: 'https://192.168.1.69:10443',
    pluginId: '@scrypted/core',
    username: process.env.SCRYPTED_USER,
    password: process.env.SCRYPTED_PASS,
  });
  await mkdir(outDir, { recursive: true });
  const systemManager = sdk.systemManager;
  for (let round = 0; round < rounds; round++) {
    // Rotate the order so each camera is sampled at different points in each round.
    const order = cameraIds.map((_, index) => cameraIds[(index + round) % cameraIds.length]);
    for (const id of order) {
      const camera = systemManager.getDeviceById(id);
      if (!camera) throw new Error(`Scrypted camera ${id} was not found`);
      const setting = (await camera.getSettings()).find(item => item.key === 'prebuffer:rtspRebroadcastUrl');
      const url = typeof setting?.value === 'string' ? setting.value : '';
      if (!url) throw new Error(`Scrypted camera ${id} has no prebuffer rebroadcast URL`);
      const recordedAt = new Date().toISOString();
      const file = `camera-${id}-round-${round + 1}-${recordedAt.replace(/[-:.]/g, '').replace('T', '_').replace('Z', 'Z')}.wav`;
      const output = path.join(outDir, file);
      try {
        const input = await inputAudioInfo(url);
        const capturedDurationSeconds = await capture(url, output);
        manifest.push({ camera_id: id, camera_name: CAMERAS.get(id), round: round + 1, recorded_at: recordedAt, requested_duration_seconds: durationSeconds, duration_seconds: capturedDurationSeconds, input_audio: input, path: path.relative(DATA, output) });
        say(`Captured camera ${id} (${CAMERAS.get(id)}), round ${round + 1}: ${capturedDurationSeconds.toFixed(1)}s`);
      } catch (error) {
        say(`Capture failed for camera ${id}, round ${round + 1}: ${error.message}`);
        throw error;
      }
    }
    if (round + 1 < rounds && gapSeconds) await delay(gapSeconds * 1000);
  }
  await writeFile(path.join(outDir, 'manifest.json'), `${JSON.stringify({ session, captures: manifest }, null, 2)}\n`);
  say(`Saved ${manifest.length} capture(s) under audio-eval/data/backgrounds/raw/${session}/`);
} catch {
  say('Camera capture stopped. Details were suppressed to protect Scrypted credentials and rebroadcast URLs.');
  process.exitCode = 1;
} finally {
  try { sdk?.disconnect(); } catch {}
  for (const key of Object.keys(originalConsole)) console[key] = originalConsole[key];
}
