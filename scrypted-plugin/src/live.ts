// A current picture per camera for the dashboard's Live tiles of snapshot-only cameras (no NVR card,
// so there is no video stream to show). Dependency-free on purpose: main.ts imports it, and the unit
// tests import it directly without the Scrypted SDK.
//
// The rules, all of which exist to be kind to the cameras and to this process:
//  - A picture is only ever taken because someone asked for one. There are no timers.
//  - Requests that arrive while a picture is being taken share that one capture (single flight).
//  - A camera is asked for a new picture at most once per TTL (15 s), counted from when the last
//    capture started, so a client that asks every 16 s gets a new picture every time.
//  - Only cameras that exist may be captured or remembered, so memory is bounded by the camera count.
//  - A camera that cannot answer is left alone for longer each time (15 s, 30 s, then 60 s), and a
//    capture that never answers is given up on, so it can neither pile up nor wedge the camera.
//  - Pictures live in memory only; nothing is written to disk.
import { createHash } from 'node:crypto';

export const LIVE_PICTURE_WIDTH = 960;
export const LIVE_PICTURE_QUALITY = 75;
export const LIVE_PICTURE_TTL_MS = 15_000;
// How long the camera is told it may take. Some cameras answer cold (a doorbell asleep behind a
// cloud service) only after more than ten seconds, then answer from cache.
export const LIVE_CAPTURE_TIMEOUT_MS = 20_000;
// A hard wall-clock limit that also covers converting and resizing, so one stuck call cannot hold a camera.
export const LIVE_CAPTURE_DEADLINE_MS = 23_000;
export const LIVE_FAILURE_MAX_BACKOFF_MS = 60_000;
// A picture counts as current for at least this long after it was taken, even when taking it was slow.
const MIN_FRESH_AFTER_CAPTURE_MS = 2_000;

export interface LivePicture {
    buffer: Buffer;
    // Quoted strong validator for the bytes: the same picture always has the same ETag.
    etag: string;
    // When the capture finished, in ms since the epoch (what Last-Modified reports).
    capturedAt: number;
}

export function etagFor(buffer: Buffer): string {
    return `"${createHash('sha1').update(buffer).digest('hex').slice(0, 24)}"`;
}

// Does an If-None-Match header name this ETag (or `*`)? Weak validators compare equal to strong ones.
export function etagMatches(header: string | undefined, etag: string): boolean {
    if (!header) return false;
    const wanted = etag.replace(/^W\//, '');
    return header.split(',').some(token => {
        const candidate = token.trim();
        return candidate === '*' || candidate.replace(/^W\//, '') === wanted;
    });
}

export interface LivePictureSource {
    // Takes one picture as JPEG bytes; rejects when the camera cannot.
    capture(cameraId: string): Promise<Buffer>;
    // Only ids for which this is true are captured or remembered, which bounds the cache by the camera count.
    isCamera(cameraId: string): boolean;
    // Told when a capture failed and when the camera will next be asked. Must not be relied on to throw.
    onFailure?(cameraId: string, error: unknown, consecutiveFailures: number, retryInMs: number): void;
}

export interface LivePictureOptions {
    ttlMs?: number;
    deadlineMs?: number;
    maxBackoffMs?: number;
    now?: () => number;
}

interface Entry {
    // The picture, or undefined when the last capture failed.
    picture: LivePicture | undefined;
    // Until when this entry is trusted; after that the next request captures again.
    until: number;
    failures: number;
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
        // A late answer after the deadline lands on an already-settled promise and is dropped.
        promise.then(
            value => { clearTimeout(timer); resolve(value); },
            error => { clearTimeout(timer); reject(error); },
        );
    });
}

export class LivePictureCache {
    private readonly source: LivePictureSource;
    private readonly entries = new Map<string, Entry>();
    private readonly flights = new Map<string, Promise<LivePicture | undefined>>();
    private readonly ttlMs: number;
    private readonly deadlineMs: number;
    private readonly maxBackoffMs: number;
    private readonly now: () => number;

    constructor(source: LivePictureSource, options: LivePictureOptions = {}) {
        this.source = source;
        this.ttlMs = options.ttlMs ?? LIVE_PICTURE_TTL_MS;
        this.deadlineMs = options.deadlineMs ?? LIVE_CAPTURE_DEADLINE_MS;
        this.maxBackoffMs = options.maxBackoffMs ?? LIVE_FAILURE_MAX_BACKOFF_MS;
        this.now = options.now ?? Date.now;
    }

    // How many cameras are remembered (never more than there are cameras).
    get size(): number {
        return this.entries.size;
    }

    // The camera's current picture, or undefined when it cannot give one right now (not a camera, or its
    // last capture failed and it is being left alone). The caller then falls back to something else.
    async get(cameraId: string): Promise<LivePicture | undefined> {
        if (!this.source.isCamera(cameraId)) return undefined;
        const entry = this.entries.get(cameraId);
        if (entry && this.now() < entry.until) return entry.picture;
        return this.flights.get(cameraId) ?? this.start(cameraId, entry?.failures ?? 0);
    }

    clear(): void {
        this.entries.clear();
        this.flights.clear();
    }

    private start(cameraId: string, failures: number): Promise<LivePicture | undefined> {
        const flight = this.take(cameraId, failures);
        this.flights.set(cameraId, flight);
        void flight.then(() => { if (this.flights.get(cameraId) === flight) this.flights.delete(cameraId); });
        return flight;
    }

    // Never rejects: a failure is recorded and answered with undefined.
    private async take(cameraId: string, failures: number): Promise<LivePicture | undefined> {
        const startedAt = this.now();
        try {
            const buffer = await withDeadline(this.source.capture(cameraId), this.deadlineMs);
            if (!buffer.length) throw new Error('the camera returned an empty picture');
            const capturedAt = this.now();
            const picture: LivePicture = { buffer, etag: etagFor(buffer), capturedAt };
            this.entries.set(cameraId, { picture, until: Math.max(startedAt + this.ttlMs, capturedAt + MIN_FRESH_AFTER_CAPTURE_MS), failures: 0 });
            return picture;
        } catch (error) {
            const count = failures + 1;
            const retryInMs = Math.min(this.ttlMs * 2 ** Math.min(count - 1, 10), this.maxBackoffMs);
            this.entries.set(cameraId, { picture: undefined, until: this.now() + retryInMs, failures: count });
            try {
                this.source.onFailure?.(cameraId, error, count, retryInMs);
            } catch {
                // Reporting a failure must never turn it into a different one.
            }
            return undefined;
        }
    }
}
