// The boxes the detector draws around an animal, kept with the visit so its clip can show what the model saw. It has no runtime
// dependencies on purpose (the store imports below are types only, which are erased): main.ts imports it, and the unit tests import it
// directly without the Scrypted SDK, driving these same functions against a real store.
//
// Where the boxes come from: every Scrypted detection event lists the animals it found as pixel boxes in the picture the detector looked
// at (`inputDimensions`), which has the same shape as the recorded clip, so a box divided by those dimensions lands on the clip's frame.
// The recorder keeps at most four events a second per camera. A visit does not exist yet when the first events of an animal arrive (it
// is made once the classifier has named the animal, up to 30 s later), so events wait in a short per-camera buffer and move into the
// visit when it is made; once the visit exists they go straight into it. What a visit may hold is the store's rule (TRACK_MAX_FRAMES).

import type { ClipSource, Visit } from './store';

// One box the detector drew, as a share of the frame the clip shows (top-left origin). `className` is what the detector calls it and
// `score` how sure it is that something is there (NOT how sure it is of the species). `id` is the detector's own name for the animal,
// the same on every event for as long as it follows it. `label` is the wildlife classifier's species, only on an event where it had one
// (it names an animal once it is at least 70% sure); `labelScore` is its confidence, which Scrypted's NVR almost never passes on.
export interface TrackBox {
    x: number;
    y: number;
    w: number;
    h: number;
    className: string;
    score: number;
    id?: string;
    label?: string;
    labelScore?: number;
}

// Everything the detector saw in one event: `t` is the event's own timestamp (wall-clock ms), every box is an animal in that picture.
export interface TrackSample {
    t: number;
    boxes: TrackBox[];
}

// What the store keeps of one visit: when its clip starts (wall-clock ms; null when unknown), where the boxes were measured to lie in the
// clip's video (ms to add to a detection's time; null when that was not measured, see align.ts) and the samples, oldest first.
export interface VisitTrack {
    clipStartAt: number | null;
    clipOffsetMs: number | null;
    frames: TrackSample[];
}

// The `detections` object of a visit answer. A sample's moment in the recorded video is `t + offsetMs - clipStartAt` ms from the start
// of the clip.
export interface VisitDetections {
    clipStartAt: number;
    offsetMs: number;
    frames: TrackSample[];
}

export type VisitPayload = Visit | (Visit & { detections: VisitDetections });

// At most four events a second per camera are kept: a moving box is still smooth, and a visit's track stays small.
export const TRACK_MIN_GAP_MS = 250;
// How long events wait for their visit to be made: an animal waits up to 30 s for the classifier to name it before it becomes a
// visit, and committing it takes a moment more. A visit made later than this is missing its first events (it gets every event after
// it exists).
export const TRACK_BUFFER_MS = 60_000;
// Events up to this much older than a visit's start still count as its own, so a visit does not lose the frame just before the event
// that started it.
export const TRACK_SLACK_MS = 1_000;

// What normalizeBoxes reads of one detection (Scrypted's detection result, as far as it matters here).
export interface RawDetection {
    className?: string;
    label?: string | null;
    score?: number | null;
    labelScore?: number | null;
    id?: string;
    boundingBox?: number[];
}

function isNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function unit(value: number): number {
    return Math.min(1, Math.max(0, value));
}

function round(value: number, scale: 100 | 1000): number {
    return Math.round(value * scale) / scale;
}

// A detection's pixel box `[x, y, w, h]` as a share of the frame, kept inside it (a box that sticks out is cut at the frame's edge);
// undefined when it is not a box at all: not four numbers, no size, or nothing of it inside the frame. Without the picture's size
// (`size` undefined) a box is believed only when its four numbers are already shares of the frame.
function frameBox(raw: unknown, size: { width: number; height: number } | undefined): Pick<TrackBox, 'x' | 'y' | 'w' | 'h'> | undefined {
    if (!Array.isArray(raw) || raw.length !== 4 || !raw.every(isNumber)) return undefined;
    const [x, y, w, h] = raw as number[];
    if (w <= 0 || h <= 0) return undefined;
    if (!size && !raw.every(value => value >= 0 && value <= 1)) return undefined;
    const scaleX = size ? size.width : 1;
    const scaleY = size ? size.height : 1;
    const left = unit(x / scaleX);
    const top = unit(y / scaleY);
    const box = { x: round(left, 1000), y: round(top, 1000), w: round(unit((x + w) / scaleX) - left, 1000), h: round(unit((y + h) / scaleY) - top, 1000) };
    return box.w > 0 && box.h > 0 ? box : undefined;
}

// The animals of one detection event as the boxes a visit keeps: positions as shares of the frame (3 decimals), scores to 2 decimals,
// `id`, `label` and `labelScore` only where the event had them. A detection without a usable box, class name or score is left out.
export function normalizeBoxes(detections: readonly RawDetection[], inputDimensions: readonly number[] | undefined): TrackBox[] {
    const width = inputDimensions?.[0];
    const height = inputDimensions?.[1];
    const size = isNumber(width) && isNumber(height) && width > 0 && height > 0 ? { width, height } : undefined;
    const boxes: TrackBox[] = [];
    for (const detection of detections) {
        const frame = frameBox(detection.boundingBox, size);
        if (!frame || !detection.className || !isNumber(detection.score)) continue;
        const box: TrackBox = { ...frame, className: detection.className, score: round(unit(detection.score), 100) };
        if (detection.id) box.id = detection.id;
        if (detection.label) box.label = detection.label;
        if (isNumber(detection.labelScore)) box.labelScore = round(unit(detection.labelScore), 100);
        boxes.push(box);
    }
    return boxes;
}

// What the recorder needs from the store; KestrelStore satisfies it as is.
export interface TrackPorts {
    // Adds samples (oldest first) to a visit's track; the store decides what a visit may hold.
    appendTrackFrames(visitId: string, samples: readonly TrackSample[]): void;
}

// Keeps the detection events of every camera for the visit they belong to. The visit is not known when an event arrives (main.ts asks
// the same-moment tracker, which knows the visit an animal is currently inside): an event that has a visit goes straight into it, any
// other waits in its camera's buffer until `attach` hands the buffer to the visit that was just made (or that the animal was folded
// into). Everything is synchronous, so no event can fall between the buffer and the visit.
export class TrackRecorder {
    private readonly ports: TrackPorts;
    // The time of the newest event kept, per camera: the throttle.
    private readonly lastKept = new Map<string, number>();
    // The events that have no visit yet, per camera, oldest first. Events are at least TRACK_MIN_GAP_MS apart and none is older than
    // TRACK_BUFFER_MS next to the newest, so a buffer never holds more than TRACK_BUFFER_MS / TRACK_MIN_GAP_MS + 1 of them.
    private readonly buffers = new Map<string, TrackSample[]>();

    constructor(ports: TrackPorts) {
        this.ports = ports;
    }

    // One detection event of `cameraId`. `openVisitId` is the visit the animal is currently inside, if there is one.
    observe(cameraId: string, sample: TrackSample, openVisitId?: string): void {
        // An event less than TRACK_MIN_GAP_MS after the last one kept is dropped, and so is one that is older than it.
        const last = this.lastKept.get(cameraId);
        if (last !== undefined && sample.t - last < TRACK_MIN_GAP_MS) return;
        this.lastKept.set(cameraId, sample.t);
        if (openVisitId !== undefined) {
            this.ports.appendTrackFrames(openVisitId, [sample]);
            return;
        }
        let buffer = this.buffers.get(cameraId);
        if (!buffer) {
            buffer = [];
            this.buffers.set(cameraId, buffer);
        }
        buffer.push(sample);
        const young = buffer.findIndex(item => sample.t - item.t <= TRACK_BUFFER_MS);
        if (young > 0) buffer.splice(0, young);
    }

    // `visitId` was just made (or took the animal in) and starts at `since`: the buffered events from a moment before then are its
    // own. The camera's buffer is emptied either way: what is older belongs to no visit, and from now on events go straight in.
    attach(cameraId: string, visitId: string, since: number): void {
        const buffer = this.buffers.get(cameraId);
        if (!buffer) return;
        this.buffers.delete(cameraId);
        const own = buffer.filter(sample => sample.t >= since - TRACK_SLACK_MS);
        if (own.length) this.ports.appendTrackFrames(visitId, own);
    }

    forget(cameraId: string): void {
        this.lastKept.delete(cameraId);
        this.buffers.delete(cameraId);
    }

    clear(): void {
        this.lastKept.clear();
        this.buffers.clear();
    }
}

// How many ms to ADD to a detection event's time to get the moment the same scene is in the recorded clip (positive: the video shows it
// later than the detector's timestamp says). This is only what is used when the footage of a clip did not show its own offset clearly
// (align.ts measures that for every clip it can). The defaults were measured on 2026-10-30 on 30 real clips of cameras 88, 103 and 104,
// against the clip starts worked out in clips.ts:
// - events: +330. The video of an Events Recorder clip lags its detections by +200 ms (sd about 0.04 s on camera 103; 88 and 104 agree),
//   measured from a start worked out with the video's true length. Kestrel reads the length as the last packet's timestamp, about 3 frames
//   (130 ms) short of that, which puts the start 130 ms late, so 200 + 130.
// - nvr: -440. The start of a cut is off by a different amount for every clip, from -980 to +60 ms (median -440, sd about 310 ms): the NVR's
//   recorded timestamps jitter from one segment to the next. The end of its stream is accurate, its first frame's time is not. No constant
//   is right for a clip; the median is the least wrong one.
export const DEFAULT_OFFSET_MS: Record<ClipSource, number> = { events: 330, nvr: -440 };

// A camera whose clips turn out to differ from the defaults above gets its own number here (none does so far).
export const CAMERA_OFFSET_MS: Record<string, Partial<Record<ClipSource, number>>> = {};

export function detectionOffsetMs(cameraId: string, source: ClipSource | undefined): number {
    return source === undefined ? 0 : CAMERA_OFFSET_MS[cameraId]?.[source] ?? DEFAULT_OFFSET_MS[source];
}

// The visit as a single-visit answer carries it: a seen visit whose clip is ready gets its `detections` (the boxes, when the clip
// starts and how far its video lags the detections) once the clip's start is known and at least one event was kept; every other visit is
// returned as it is, so lists, events and heard visits never grow. The offset is the one measured for the clip, or the default.
export function visitPayload(visit: Visit, tracks: { getTrack(visitId: string): VisitTrack }): VisitPayload {
    if (visit.kind !== 'seen' || visit.clip.state !== 'ready') return visit;
    const { clipStartAt, clipOffsetMs, frames } = tracks.getTrack(visit.id);
    if (clipStartAt === null || !frames.length) return visit;
    return { ...visit, detections: { clipStartAt, offsetMs: clipOffsetMs ?? detectionOffsetMs(visit.camera.id, visit.clip.source), frames } };
}
