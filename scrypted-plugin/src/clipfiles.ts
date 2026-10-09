// Kestrel's own clip files: where they live, how a clip is copied into the store, how one is cut out of the NVR's recording
// with ffmpeg, and the keeper that looks after them (copy when a clip becomes ready, migrate the old ones, notice vanished
// files, delete on request). It uses Node built-ins only (no Scrypted SDK) and imports types only from the store, so the unit
// tests import it directly and drive it against a real store in a temp directory.
//
// The NVR's recording stream (what `getRecordingStream` hands out) is an RTSP stream on the Scrypted host that begins at
// the keyframe at or BEFORE the requested start time and ends exactly at the end of the requested window (measured live:
// asking for 12 s gave 13.4 s, 14.4 s and 15.9 s of video for starts 0, 1 and 2.5 s later, all ending at the same moment).
// It is H.265 on some cameras, so a clip is re-encoded to H.264 for browsers. Its audio track is only usable on some
// cameras: on the Backyard camera the AAC timestamps are all squashed into the first 0.02 s (the Events Recorder's own
// clips of that camera carry the same damaged audio), so audio is kept only when its timestamps span the video.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { ClipSource, KestrelStore, Visit } from './store';

// On the big NVR disk, not the small plugin volume. One folder per camera, one file per visit.
export const CLIP_STORE_DIR = '/NVR/kestrel/clips';

const UNSAFE_NAME = /[^A-Za-z0-9._-]/g;
// Copying the NVR's stream takes seconds (it is served about 20 times faster than real time); the encode shares a loaded host at
// the lowest priority, where a 35 s clip has taken two minutes.
const COPY_TIMEOUT_MS = 120_000;
const ENCODE_TIMEOUT_MS = 600_000;
const PROBE_TIMEOUT_MS = 60_000;
// An mp4 smaller than this is a header with no picture in it (a real clip is megabytes).
const MIN_CLIP_BYTES = 1_000;
// A clip just written must read back as at least this share of the length it was cut to.
const MIN_WRITTEN_SHARE = 0.9;
// The frame rate of a clip is measured from its recording and kept inside these bounds (25 when it cannot be measured).
const MIN_FPS = 10;
const MAX_FPS = 60;
const DEFAULT_FPS = 25;
// The stream may start a few seconds before the requested time (a keyframe is never far); more than this is not trusted.
const MAX_LEAD_MS = 30_000;
// Audio counts as healthy when its timestamps cover at least this share of the video's.
const AUDIO_COVERAGE = 0.8;
// Clips are cut next to the NVR and the detectors, which must keep up: the encoder yields to them. (Nice 15 was tried first: on this
// host, shared with many other jobs, it left the encode with so little CPU that a 35 s clip took more than four minutes.)
const NICE = '/usr/bin/nice';
const NICE_LEVEL = '10';
const QUIET = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y'];
// Fit inside 1920 x 1920 without ever enlarging, even sides: a 1080p camera is untouched, 2560 x 1920 becomes 1920 x 1440.
const FIT_1920 = "scale=w='min(1920,iw)':h='min(1920,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2";

export function keptClipFile(root: string, cameraId: string, visitId: string): string {
    return join(root, cameraId.replace(UNSAFE_NAME, '_'), `${visitId.replace(UNSAFE_NAME, '_')}.mp4`);
}

// Whether `file` is inside the store. Every delete checks this first, so a file another plugin owns is never removed.
export function isInsideStore(root: string, file: string): boolean {
    const path = relative(root, file);
    return path !== '' && path.split(sep)[0] !== '..' && !isAbsolute(path);
}

// Copies `source` into the store as `destination` (through a .part file, so a half-written clip is never served) and
// returns its size. Throws when the copy is not byte-for-byte the same length.
export async function copyIntoStore(source: string, destination: string): Promise<number> {
    await mkdir(dirname(destination), { recursive: true });
    const part = `${destination}.part`;
    try {
        await copyFile(source, part);
        const [from, to] = await Promise.all([stat(source), stat(part)]);
        if (to.size === 0 || from.size !== to.size) throw new Error(`The copy of ${source} is incomplete (${to.size} of ${from.size} bytes)`);
        await rename(part, destination);
        return to.size;
    } catch (error) {
        await rm(part, { force: true });
        throw error;
    }
}

// Leftovers of a cut or copy the plugin did not live to finish. Returns how many it removed.
export async function removeStalePartials(root: string, now: number, olderThanMs = 10 * 60_000): Promise<number> {
    let removed = 0;
    for (const folder of await readdir(root, { withFileTypes: true }).catch(() => [])) {
        if (!folder.isDirectory()) continue;
        for (const name of await readdir(join(root, folder.name)).catch(() => [] as string[])) {
            if (!name.endsWith('.part') && !name.endsWith('.raw.mkv')) continue;
            const path = join(root, folder.name, name);
            const info = await stat(path).catch(() => undefined);
            if (info && now - info.mtimeMs > olderThanMs) { await rm(path, { force: true }); removed++; }
        }
    }
    return removed;
}

export interface Ran { code: number | null; stderr: string; timedOut: boolean }

// Every ffmpeg this module started and that is still running, so the plugin can stop them when it is released (a child outlives its
// parent otherwise, and would go on writing a clip nobody is waiting for).
const running = new Set<ChildProcess>();

export function stopRunningCuts(): void {
    for (const child of running) child.kill('SIGKILL');
}

function run(ffmpegPath: string, args: string[], timeoutMs: number): Promise<Ran> {
    const niced = existsSync(NICE);
    const { promise, resolve } = Promise.withResolvers<Ran>();
    let stderr = '';
    let timedOut = false;
    const child = spawn(niced ? NICE : ffmpegPath, niced ? ['-n', NICE_LEVEL, ffmpegPath, ...args] : args, { stdio: ['ignore', 'ignore', 'pipe'] });
    running.add(child);
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('latin1')).slice(-8_192); });
    child.on('error', error => { clearTimeout(timer); running.delete(child); resolve({ code: null, stderr: `${stderr}${String(error)}`, timedOut }); });
    child.on('close', code => { clearTimeout(timer); running.delete(child); resolve({ code, stderr, timedOut }); });
    return promise;
}

function failure(step: string, ran: Ran): string {
    const lines = ran.stderr.split(/[\r\n]+/).map(line => line.trim()).filter(Boolean);
    return `${step} ${ran.timedOut ? 'timed out' : `failed (exit ${ran.code})`}: ${lines.slice(-3).join(' | ')}`;
}

// How far the timestamps of one stream of `file` run, in ms, and how many frames (packets) it has: both 0 when the stream does not
// exist. ffmpeg prints `frame=N` and `time=HH:MM:SS.xx` while it copies the stream to nowhere.
async function probeStream(ffmpegPath: string, file: string, map: string): Promise<{ ms: number; frames: number }> {
    const ran = await run(ffmpegPath, ['-hide_banner', '-nostdin', '-v', 'error', '-stats', '-i', file, '-map', map, '-c', 'copy', '-f', 'null', '-'], PROBE_TIMEOUT_MS);
    if (ran.code !== 0) return { ms: 0, frames: 0 };
    const times = [...ran.stderr.matchAll(/time=(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/g)];
    const counts = [...ran.stderr.matchAll(/frame=\s*(\d+)/g)];
    const last = times[times.length - 1];
    return {
        ms: last ? Math.round((Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3])) * 1000) : 0,
        frames: counts.length ? Number(counts[counts.length - 1][1]) : 0,
    };
}

// The frame rate to encode at: the recording's frames over its seconds, as a whole number inside sane bounds. It is measured because
// the file's own guess is wrong for a recording whose timestamps jitter (ffmpeg then reads 1000 fps, and encoding at that rate repeats
// every picture forty times: a 5 s slice came out as 10 MB and 100 s of CPU).
export function measuredFps(frames: number, spanMs: number): number {
    return frames > 1 && spanMs > 0 ? Math.min(MAX_FPS, Math.max(MIN_FPS, Math.round(frames / (spanMs / 1000)))) : DEFAULT_FPS;
}

// The ffmpeg arguments of the encode: `leadMs` of lead-in skipped, `keepMs` kept, H.264 at a constant `fps`, the mp4 index up front.
export function encodeArguments(job: { scratch: string; part: string; leadMs: number; keepMs: number; fps: number; audio: boolean }): string[] {
    const { scratch, part, leadMs, keepMs, fps, audio } = job;
    return [
        ...QUIET, '-ss', (leadMs / 1000).toFixed(3), '-i', scratch, '-t', (keepMs / 1000).toFixed(3),
        '-map', '0:v:0', ...(audio ? ['-map', '0:a:0'] : []), '-vf', FIT_1920,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p', '-r', String(fps), '-fps_mode', 'cfr', '-threads', '2',
        ...(audio ? ['-c:a', 'aac', '-b:a', '64k'] : ['-an']),
        '-movflags', '+faststart', '-f', 'mp4', part,
    ];
}

export interface CutRequest {
    ffmpegPath: string;
    // The NVR's FFmpeg input: every argument up to and including `-i <url>`.
    inputArguments: string[];
    // The length of the window asked of the NVR. The stream ends at the end of the window, so any video beyond this length
    // is lead-in before the requested start, and it is trimmed off.
    durationMs: number;
    destination: string;
    // Overrides both time limits (tests).
    timeoutMs?: number;
}

export type CutOutcome =
    | { ok: true; bytes: number; durationMs: number; leadMs: number; audio: boolean }
    | { ok: false; reason: string };

// Cuts the clip: copy the NVR's stream into a scratch file, measure how much lead-in came with it, then re-encode exactly the
// requested window as H.264 mp4 with the index up front (`+faststart`) so a browser starts playing at once.
export async function cutClip(request: CutRequest): Promise<CutOutcome> {
    const { ffmpegPath, inputArguments, durationMs, destination } = request;
    const copyTimeout = request.timeoutMs ?? COPY_TIMEOUT_MS;
    const encodeTimeout = request.timeoutMs ?? ENCODE_TIMEOUT_MS;
    // Names of this attempt's own scratch files: two cuts of one visit (a plugin restarted in the middle of one) never share a file.
    const token = randomBytes(4).toString('hex');
    const scratch = `${destination}.${token}.raw.mkv`;
    const part = `${destination}.${token}.part`;
    try {
        await mkdir(dirname(destination), { recursive: true });
        const copied = await run(ffmpegPath, [...QUIET, ...inputArguments, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-f', 'matroska', scratch], copyTimeout);
        if (copied.code !== 0) return { ok: false, reason: failure('Copying the recording', copied) };
        const video = await probeStream(ffmpegPath, scratch, '0:v:0');
        const videoMs = video.ms;
        if (videoMs <= 0) return { ok: false, reason: 'The recording stream has no video' };
        const audioMs = (await probeStream(ffmpegPath, scratch, '0:a:0')).ms;
        const audio = audioMs >= videoMs * AUDIO_COVERAGE;
        const fps = measuredFps(video.frames, videoMs);
        const leadMs = Math.min(MAX_LEAD_MS, Math.max(0, videoMs - durationMs));
        const keepMs = Math.min(durationMs, videoMs - leadMs);
        const encoded = await run(ffmpegPath, encodeArguments({ scratch, part, leadMs, keepMs, fps, audio }), encodeTimeout);
        if (encoded.code !== 0) return { ok: false, reason: failure('Encoding the clip', encoded) };
        const info = await stat(part);
        if (info.size < MIN_CLIP_BYTES) return { ok: false, reason: `The clip came out ${info.size} bytes` };
        // Trust nothing about a file just written: it must read back as a video about as long as it should be.
        const writtenMs = (await probeStream(ffmpegPath, part, '0:v:0')).ms;
        if (writtenMs < keepMs * MIN_WRITTEN_SHARE) return { ok: false, reason: `The clip reads back as ${writtenMs} ms of video, expected ${Math.round(keepMs)} ms` };
        await rename(part, destination);
        return { ok: true, bytes: info.size, durationMs: keepMs, leadMs, audio };
    } catch (error) {
        return { ok: false, reason: String(error) };
    } finally {
        await Promise.all([rm(scratch, { force: true }), rm(part, { force: true })]);
    }
}

export interface KeeperPorts {
    store: KestrelStore;
    // The clip store's directory.
    root: string;
    // Tells the dashboards a visit changed (a `visit_updated` event).
    announce(visit: Visit): void;
    warn(message: string): void;
}

export interface KeeperOptions {
    // Ready clips looked at per `checkVanished` call.
    checkBatch?: number;
    // Clips copied per `keepUnkept` call.
    copiesPerCall?: number;
    // How long a copy that failed is left alone.
    retryMs?: number;
    // A file another plugin wrote is copied only once it has not changed for this long (3 s by default), so a clip that is still being
    // written is never kept half-finished.
    quietMs?: number;
    now?: () => number;
}

export type ClipDeleteRequest = { visitIds: string[] } | { olderThan: number } | { reason: 'notAnimal' };
export interface ClipDeleteResult { deleted: number; freedBytes: number }

const MAX_DELETE_IDS = 1_000;
// This many of Kestrel's own clips missing from one batch, and no kept clip of the batch present, is taken to be a disk that is not there.
const MASS_VANISH = 5;

function badRequest(message: string): Error {
    return Object.assign(new Error(message), { status: 400 });
}

// `olderThan` as a request carries it (query string or JSON): a millisecond timestamp in the past.
export function parseOlderThan(value: unknown, now: number): number {
    // A query string carries a number as text, and a client that holds it as a float writes "1790000000000.0".
    const at = typeof value === 'string' && /^\d+(\.\d+)?$/.test(value) ? Math.floor(Number(value)) : value;
    if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0 || at > now) throw badRequest('olderThan must be a millisecond timestamp in the past');
    return at;
}

// The body of `POST clips/delete`: exactly one of `{ visitIds }`, `{ olderThan }` or `{ reason: "notAnimal" }`. Throws a 400.
export function parseClipDelete(body: Record<string, unknown>, now: number): ClipDeleteRequest {
    const keys = Object.keys(body);
    if (keys.length !== 1) throw badRequest('Send exactly one of visitIds, olderThan or reason');
    if (keys[0] === 'visitIds') {
        const ids = body.visitIds;
        if (!Array.isArray(ids) || !ids.length || ids.length > MAX_DELETE_IDS || ids.some(id => typeof id !== 'string' || !id || id.length > 200))
            throw badRequest(`visitIds must be a list of 1 to ${MAX_DELETE_IDS} visit ids`);
        return { visitIds: [...new Set(ids as string[])] };
    }
    if (keys[0] === 'olderThan') {
        if (typeof body.olderThan !== 'number') throw badRequest('olderThan must be a millisecond timestamp in the past');
        return { olderThan: parseOlderThan(body.olderThan, now) };
    }
    if (keys[0] === 'reason' && body.reason === 'notAnimal') return { reason: 'notAnimal' };
    throw badRequest('Send exactly one of visitIds, olderThan or reason ("notAnimal")');
}

// Looks after the clips of visits. The Events Recorder prunes its clips (20 GB per camera) and the NVR deletes its footage after
// its retention, so every clip that becomes ready gets a copy of its own in Kestrel's clip store, which only a person's delete
// request removes (it is outside the plugin's media budget).
export class ClipKeeper {
    private readonly ports: KeeperPorts;
    private readonly checkBatch: number;
    private readonly copiesPerCall: number;
    private readonly retryMs: number;
    private readonly quietMs: number;
    private readonly now: () => number;
    // Where the check for vanished files stopped: the id of the last ready clip it looked at.
    private cursor = '';
    private readonly retryAt = new Map<string, number>();
    private storeWarnedAt = 0;

    constructor(ports: KeeperPorts, options: KeeperOptions = {}) {
        this.ports = ports;
        this.checkBatch = options.checkBatch ?? 200;
        this.copiesPerCall = options.copiesPerCall ?? 3;
        this.retryMs = options.retryMs ?? 10 * 60_000;
        this.quietMs = options.quietMs ?? 3_000;
        this.now = options.now ?? Date.now;
    }

    // A visit's clip has been found or cut: record it, give it a copy of its own in the clip store, and tell the dashboards. When the
    // copy cannot be made the other plugin's file stays linked and keepUnkept tries again later.
    async ready(id: string, cameraId: string, file: string, source: ClipSource): Promise<void> {
        const { store, root } = this.ports;
        let stored = file;
        let bytes: number | null = null;
        if (isInsideStore(root, file)) {
            bytes = (await stat(file)).size;
        } else {
            const copy = await this.copy(id, cameraId, file);
            if (copy) { stored = copy.file; bytes = copy.bytes; }
        }
        store.setClip(id, 'ready', stored, { source, kept: bytes !== null, bytes });
        const visit = store.getVisit(id);
        if (visit) this.ports.announce(visit);
    }

    // Whether a clip file that is not there means the clip is gone: always for another plugin's file, but for one of Kestrel's own only
    // while the clip store itself is there (a disk that has not come back yet is not a deleted clip).
    isGone(file: string | null): boolean {
        if (!file) return true;
        if (existsSync(file)) return false;
        return !isInsideStore(this.ports.root, file) || existsSync(this.ports.root);
    }

    // Every ready clip's file must still exist. One that vanished (deleted by hand, pruned by the Events Recorder) turns the clip into
    // 'deleted' so nobody is offered a dead link. A batch per call, walking through ALL ready clips. When every one of Kestrel's own
    // clips in a batch is missing at once, that is a disk that is not mounted rather than a clean-out: their links are left alone.
    checkVanished(): void {
        const { store, root } = this.ports;
        const rows = store.listReadyClipFiles(this.cursor, this.checkBatch);
        this.cursor = rows.length < this.checkBatch ? '' : rows[rows.length - 1].id;
        const ours = (row: { clip_file: string | null }) => !!row.clip_file && isInsideStore(root, row.clip_file);
        const gone = rows.filter(row => this.isGone(row.clip_file));
        const oursGone = gone.filter(ours).length;
        const diskMissing = oursGone >= MASS_VANISH && oursGone === rows.filter(ours).length;
        if (diskMissing && this.now() - this.storeWarnedAt > 3_600_000) {
            this.storeWarnedAt = this.now();
            this.ports.warn(`${oursGone} of Kestrel's own clips are missing from ${root} at once: leaving their links alone in case the disk is not mounted.`);
        }
        for (const row of gone) {
            if (diskMissing && ours(row)) continue;
            store.setClip(row.id, 'deleted', null);
            const visit = store.getVisit(row.id);
            if (visit) this.ports.announce(visit);
        }
    }

    // Gives every ready clip that is still another plugin's file a copy of its own. At start-up this migrates the clips that existed
    // before the store did; later it retries copies that failed. A few per call; a failed one is left alone for a while.
    async keepUnkept(): Promise<void> {
        const { store } = this.ports;
        const now = this.now();
        let tried = 0;
        for (const row of store.listUnkeptReadyClips(this.copiesPerCall * 10)) {
            if (tried >= this.copiesPerCall) return;
            if (!row.clip_file || !existsSync(row.clip_file) || (this.retryAt.get(row.id) ?? 0) > now) continue;
            tried++;
            const copy = await this.copy(row.id, row.camera_id, row.clip_file);
            if (copy) {
                store.markClipKept(row.id, copy.file, copy.bytes);
                this.retryAt.delete(row.id);
            } else {
                this.retryAt.set(row.id, now + this.retryMs);
            }
        }
    }

    // Deletes clips on a person's request: the file (only ever one inside the clip store; another plugin's file is left alone), then the
    // visit's clip becomes 'deleted' by 'user'. The visit, its photos and everything else stay. A clip whose file cannot be removed is
    // left as it was. Visits without a ready clip are not counted.
    async remove(request: ClipDeleteRequest): Promise<ClipDeleteResult> {
        const { store, root } = this.ports;
        const rows = 'visitIds' in request ? store.clipsByIds(request.visitIds)
            : 'olderThan' in request ? store.clipsStartedBefore(request.olderThan)
            : store.clipsMarkedNotAnimal();
        let deleted = 0;
        let freedBytes = 0;
        for (const row of rows) {
            if (row.clip_file && row.clip_kept && isInsideStore(root, row.clip_file)) {
                const size = (await stat(row.clip_file).catch(() => undefined))?.size ?? 0;
                try {
                    await rm(row.clip_file, { force: true });
                } catch (error) {
                    this.ports.warn(`Could not delete the clip of visit ${row.id}: ${String(error)}`);
                    continue;
                }
                freedBytes += size;
            }
            store.setClip(row.id, 'deleted', null, { deletedBy: 'user' });
            const visit = store.getVisit(row.id);
            if (visit) this.ports.announce(visit);
            deleted++;
        }
        return { deleted, freedBytes };
    }

    private async copy(visitId: string, cameraId: string, file: string): Promise<{ file: string; bytes: number } | undefined> {
        const destination = keptClipFile(this.ports.root, cameraId, visitId);
        try {
            // Wait until the file has not changed for quietMs (a writer may still be finishing it); a few looks at most.
            for (let look = 0; look < 10; look++) {
                const untouchedFor = Date.now() - (await stat(file)).mtimeMs;
                if (untouchedFor >= this.quietMs) break;
                const { promise, resolve } = Promise.withResolvers<void>();
                setTimeout(resolve, Math.min(this.quietMs, this.quietMs - untouchedFor) + 25);
                await promise;
            }
            return { file: destination, bytes: await copyIntoStore(file, destination) };
        } catch (error) {
            this.ports.warn(`Could not copy the clip of visit ${visitId} into Kestrel's clip store (${this.ports.root}): ${String(error)}`);
            return undefined;
        }
    }
}
