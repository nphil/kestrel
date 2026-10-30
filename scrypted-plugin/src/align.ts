// Where the boxes the detector drew really are in a clip's video, measured from the footage itself. It has no runtime dependencies on
// purpose (the import below is a type only, which is erased): main.ts imports it, and the unit tests import it directly without the
// Scrypted SDK, driving these same functions over pictures they make up.
//
// Why this exists: a detection event is stamped with the moment the detector looked, and a clip with the moment its recording began, but
// the two do not sit on one clock. An Events Recorder clip lags its detections by a steady 0.2 to 0.3 s; a clip cut from the NVR's
// recording is off by a different amount every time (measured on 30 real clips, from 1 s early to 0.06 s late, because the NVR's recorded
// timestamps jitter from one segment to the next), so no constant per camera can put its boxes on the animal. What can is the clip itself:
// whatever moves in it is the animal, and the offset at which the detector's boxes lie best on whatever moves is the one for that clip.
//
// How: the still background is the median of the pictures; what differs from it, after the picture's overall brightness is levelled,
// is cut into blobs. For every box the detector drew, the overlap with the blobs is taken at every moment of the clip, and averaged over
// all boxes for each offset between -3 s and +3 s. The best offset is the middle of the stretch around the peak that is nearly as good.
// The match is believed only when it is clearly there: strong, standing out from the other offsets, sharp, and made of enough boxes
// spread over enough time (see isConfidentAlignment).

import type { TrackSample } from './track';

// Grayscale pictures of a clip, `fps` a second: frame i shows video time i / fps seconds. `width` x `height` bytes each, row by row.
export interface GrayFrames {
    width: number;
    height: number;
    fps: number;
    frames: Uint8Array[];
}

// `offsetMs` has the meaning of `detections.offsetMs`: a detection at wall-clock t is at video time t + offsetMs - clipStartAt ms. The rest
// is the evidence for it: `score` is the mean overlap (0 to 1) of the boxes with what moves at that offset, `contrast` how far that stands
// above the median of all offsets, `plateauMs` how wide the stretch around it is that is nearly as good (a sharp peak is narrow), `pairs`
// how many boxes lie inside the clip, and `spanMs` how far apart in time the first and the last of those are.
export interface AlignResult {
    offsetMs: number;
    score: number;
    contrast: number;
    plateauMs: number;
    pairs: number;
    spanMs: number;
}

// The offsets looked at: this far either way from "the detection's timestamp is the video's time", in steps of this much.
export const ALIGN_RANGE_MS = 3_000;
export const ALIGN_STEP_MS = 20;
// The plateau around the peak is every neighbouring offset that scores at least this share of the peak.
export const ALIGN_PLATEAU_SHARE = 0.92;
// A match is believed only when ALL of these hold (checked against 30 real clips on 2026-10-30); a clip that fails keeps the default offset:
export const ALIGN_MIN_SCORE = 0.4;            // the peak overlap: a box that is on the animal overlaps it by well over half
export const ALIGN_MIN_CONTRAST = 0.15;        // the peak stands out from the median offset (an animal that never moves matches everywhere)
export const ALIGN_MAX_PLATEAU_MS = 600;       // and is sharp: a wide plateau is an animal that hardly moves, so any offset fits
export const ALIGN_MIN_PAIRS = 6;              // at least this many boxes inside the clip...
export const ALIGN_MIN_SPAN_MS = 2_000;        // ...spread over at least this much time

// How the pictures are cut into blobs.
const FLAT_FRAME_STD = 5;                      // a picture flatter than this (a black or grey frame) shows nothing and is left out
const BACKGROUND_FRAMES = 128;                 // the background is the median of at most this many pictures, evenly spread
const MIN_THRESHOLD = 14;                      // a pixel is "different" when it differs by more than this...
const THRESHOLD_NOISE_FACTOR = 4;              // ...and more than this many times the typical (median) difference, plus
const THRESHOLD_NOISE_BASE = 8;                // this much: a noisy picture needs a bigger difference
const MIN_BLOB_PIXELS = 6;                     // a blob is at least this many pixels and at least
const MIN_BLOB_SHARE = 0.0006;                 // this share of the picture
const EDGE_MARGIN = 0.05;                      // the top and bottom of the picture this share high are ignored: the cameras burn the clock in there
const GROW_SHARE = 0.25;                       // blobs that touch a box grown by this much on every side count together as one animal

interface Blob { x: number; y: number; w: number; h: number }
// One box the detector drew: where it lies in the clip's pictures (in pixels) and when it was drawn (seconds from the clip's start).
interface Pair { at: number; x: number; y: number; w: number; h: number }

// What the blob cutting works in, allocated once per measurement and reused for every picture.
interface Scratch {
    size: number;
    levels: Int32Array;
    difference: Uint8Array;
    sums: Uint16Array;
    blurred: Uint8Array;
    mask: Uint8Array;
    spare: Uint8Array;
    stack: Int32Array;
}

function newScratch(width: number, height: number): Scratch {
    const size = width * height;
    return {
        size, levels: new Int32Array(511), difference: new Uint8Array(size), sums: new Uint16Array(size), blurred: new Uint8Array(size),
        mask: new Uint8Array(size), spare: new Uint8Array(size), stack: new Int32Array(size),
    };
}

// The middle value of a histogram of `count` values: the first bin the running total passes half of them at.
function histogramMedian(levels: Int32Array, bins: number, count: number): number {
    let total = 0;
    for (let bin = 0; bin < bins; bin++) {
        total += levels[bin];
        if (total > count >> 1) return bin;
    }
    return bins - 1;
}

function spread(frame: Uint8Array): number {
    let sum = 0;
    let squares = 0;
    for (let i = 0; i < frame.length; i++) {
        sum += frame[i];
        squares += frame[i] * frame[i];
    }
    const mean = sum / frame.length;
    return Math.sqrt(Math.max(0, squares / frame.length - mean * mean));
}

// The still picture behind everything that moves: for every pixel, the median over the given pictures.
function medianFrame(sources: readonly Uint8Array[], size: number): Uint8Array {
    const background = new Uint8Array(size);
    const column = new Uint8Array(sources.length);
    const middle = sources.length >> 1;
    for (let i = 0; i < size; i++) {
        for (let k = 0; k < sources.length; k++) column[k] = sources[k][i];
        column.sort();
        background[i] = sources.length % 2 ? column[middle] : (column[middle - 1] + column[middle]) >> 1;
    }
    return background;
}

// 3 x 3 average, the picture's edge repeating outward.
function boxBlur(source: Uint8Array, target: Uint8Array, sums: Uint16Array, width: number, height: number): void {
    for (let y = 0; y < height; y++) {
        const row = y * width;
        for (let x = 0; x < width; x++) sums[row + x] = source[row + (x > 0 ? x - 1 : 0)] + source[row + x] + source[row + (x < width - 1 ? x + 1 : x)];
    }
    for (let y = 0; y < height; y++) {
        const up = (y > 0 ? y - 1 : 0) * width;
        const row = y * width;
        const down = (y < height - 1 ? y + 1 : y) * width;
        for (let x = 0; x < width; x++) target[row + x] = (sums[up + x] + sums[row + x] + sums[down + x] + 4) / 9;
    }
}

// 3 x 3 grow (every pixel with a set neighbour is set) or shrink (every pixel with an unset neighbour is unset) of a 0/1 picture. What lies
// outside the picture is ignored, so a blob at the edge is not eaten away by the edge.
function morph(source: Uint8Array, target: Uint8Array, rows: Uint8Array, width: number, height: number, grow: boolean): void {
    for (let y = 0; y < height; y++) {
        const row = y * width;
        for (let x = 0; x < width; x++) {
            let value = source[row + x];
            if (x > 0) value = grow ? value | source[row + x - 1] : value & source[row + x - 1];
            if (x < width - 1) value = grow ? value | source[row + x + 1] : value & source[row + x + 1];
            rows[row + x] = value;
        }
    }
    for (let y = 0; y < height; y++) {
        const row = y * width;
        for (let x = 0; x < width; x++) {
            let value = rows[row + x];
            if (y > 0) value = grow ? value | rows[row - width + x] : value & rows[row - width + x];
            if (y < height - 1) value = grow ? value | rows[row + width + x] : value & rows[row + width + x];
            target[row + x] = value;
        }
    }
}

// The blobs of the mask (8-connected): their bounding boxes, leaving out the ones that are too small. Marks what it visits.
function blobsOf(mask: Uint8Array, width: number, height: number, stack: Int32Array): Blob[] {
    const minPixels = Math.max(MIN_BLOB_PIXELS, MIN_BLOB_SHARE * width * height);
    const blobs: Blob[] = [];
    for (let start = 0; start < mask.length; start++) {
        if (mask[start] !== 1) continue;
        let top = 0;
        stack[top++] = start;
        mask[start] = 2;
        let area = 0;
        let x0 = width, y0 = height, x1 = 0, y1 = 0;
        while (top > 0) {
            const at = stack[--top];
            const y = (at / width) | 0;
            const x = at - y * width;
            area++;
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
            for (let dy = -1; dy <= 1; dy++) {
                const ny = y + dy;
                if (ny < 0 || ny >= height) continue;
                for (let dx = -1; dx <= 1; dx++) {
                    const nx = x + dx;
                    if (nx < 0 || nx >= width) continue;
                    const next = ny * width + nx;
                    if (mask[next] === 1) {
                        mask[next] = 2;
                        stack[top++] = next;
                    }
                }
            }
        }
        if (area >= minPixels) blobs.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
    }
    return blobs;
}

// What differs from the background in one picture, as blobs. The picture's overall brightness change (the camera's exposure or its
// infrared filter switching) is taken off first, so it does not light up the whole picture.
function movingBlobs(frame: Uint8Array, background: Uint8Array, width: number, height: number, s: Scratch): Blob[] {
    const { size, levels, difference, blurred, mask, spare } = s;
    levels.fill(0);
    for (let i = 0; i < size; i++) levels[frame[i] - background[i] + 255]++;
    const shift = histogramMedian(levels, 511, size) - 255;
    for (let i = 0; i < size; i++) {
        const change = frame[i] - background[i] - shift;
        difference[i] = change < 0 ? -change : change > 255 ? 255 : change;
    }
    boxBlur(difference, blurred, s.sums, width, height);
    levels.fill(0, 0, 256);
    for (let i = 0; i < size; i++) levels[blurred[i]]++;
    const threshold = Math.max(MIN_THRESHOLD, THRESHOLD_NOISE_FACTOR * histogramMedian(levels, 256, size) + THRESHOLD_NOISE_BASE);
    for (let i = 0; i < size; i++) mask[i] = blurred[i] > threshold ? 1 : 0;
    const margin = Math.floor(height * EDGE_MARGIN);
    mask.fill(0, 0, margin * width);
    mask.fill(0, (height - margin) * width);
    // Close (fill small holes and gaps), then open (drop specks).
    morph(mask, spare, s.difference, width, height, true);
    morph(spare, mask, s.difference, width, height, false);
    morph(mask, spare, s.difference, width, height, false);
    morph(spare, mask, s.difference, width, height, true);
    return blobsOf(mask, width, height, s.stack);
}

function overlap(pair: Pair, x: number, y: number, w: number, h: number): number {
    const across = Math.min(pair.x + pair.w, x + w) - Math.max(pair.x, x);
    const down = Math.min(pair.y + pair.h, y + h) - Math.max(pair.y, y);
    if (across <= 0 || down <= 0) return 0;
    const both = across * down;
    return both / (pair.w * pair.h + w * h - both);
}

// How well a box lies on what moves in one picture: its best overlap with a single blob, or with all the blobs that touch it (grown a
// little) taken together, since one animal is often cut in two by a fence or a branch.
function bestOverlap(pair: Pair, blobs: readonly Blob[]): number {
    const left = pair.x - GROW_SHARE * pair.w;
    const top = pair.y - GROW_SHARE * pair.h;
    const right = pair.x + pair.w * (1 + GROW_SHARE);
    const bottom = pair.y + pair.h * (1 + GROW_SHARE);
    let best = 0;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const blob of blobs) {
        best = Math.max(best, overlap(pair, blob.x, blob.y, blob.w, blob.h));
        if (blob.x > right || blob.x + blob.w < left || blob.y > bottom || blob.y + blob.h < top) continue;
        x0 = Math.min(x0, blob.x);
        y0 = Math.min(y0, blob.y);
        x1 = Math.max(x1, blob.x + blob.w);
        y1 = Math.max(y1, blob.y + blob.h);
    }
    return x1 > x0 ? Math.max(best, overlap(pair, x0, y0, x1 - x0, y1 - y0)) : best;
}

// A picture-by-picture series read at a moment between two pictures (`position` counts pictures); nothing outside the clip.
function readAt(series: Float32Array, position: number): number {
    if (position < 0 || position > series.length - 1) return 0;
    const before = Math.floor(position);
    const share = position - before;
    return before + 1 < series.length ? series[before] * (1 - share) + series[before + 1] * share : series[before];
}

// Measures how the detector's boxes line up with the moving things in the clip, whatever the outcome: the best offset and the evidence for
// it. Undefined only when there is nothing to measure: no usable pictures, or no box inside the clip. Whether to believe the measurement
// is isConfidentAlignment's call. Deterministic.
export function measureAlignment(video: GrayFrames, track: readonly TrackSample[], clipStartAt: number): AlignResult | undefined {
    const { width, height, fps, frames } = video;
    const count = frames.length;
    if (count < 2 || !(fps > 0) || !(width > 0) || !(height > 0)) return undefined;
    const lastAt = (count - 1) / fps;
    const reach = ALIGN_RANGE_MS / 1000;
    // Every box drawn, except those no offset in range brings into the clip (they could only thin the average out).
    const pairs: Pair[] = [];
    for (const sample of track) {
        const at = (sample.t - clipStartAt) / 1000;
        if (at < -reach || at > lastAt + reach) continue;
        for (const box of sample.boxes) pairs.push({ at, x: box.x * width, y: box.y * height, w: box.w * width, h: box.h * height });
    }
    const inside = pairs.filter(pair => pair.at >= 0 && pair.at <= lastAt).map(pair => pair.at);
    if (!inside.length) return undefined;
    const spanMs = (Math.max(...inside) - Math.min(...inside)) * 1000;

    // Only the pictures some box can be compared with are cut into blobs.
    const needed = new Uint8Array(count);
    for (const pair of pairs) needed.fill(1, Math.max(0, Math.floor((pair.at - reach) * fps)), Math.min(count - 1, Math.ceil((pair.at + reach) * fps)) + 1);
    const usable: number[] = [];
    for (let i = 0; i < count; i++) if (spread(frames[i]) >= FLAT_FRAME_STD) usable.push(i);
    if (!usable.length) return undefined;
    const stride = Math.ceil(usable.length / BACKGROUND_FRAMES);
    const background = medianFrame(usable.filter((_, k) => k % stride === 0).map(i => frames[i]), width * height);
    const scratch = newScratch(width, height);
    const scores = pairs.map(() => new Float32Array(count));
    for (const i of usable) {
        if (!needed[i]) continue;
        const blobs = movingBlobs(frames[i], background, width, height, scratch);
        if (!blobs.length) continue;
        for (let p = 0; p < pairs.length; p++) scores[p][i] = bestOverlap(pairs[p], blobs);
    }

    // The joint curve: the mean score over all boxes, for each offset in range.
    const steps = (2 * ALIGN_RANGE_MS) / ALIGN_STEP_MS + 1;
    const curve = new Float64Array(steps);
    for (let p = 0; p < pairs.length; p++) {
        for (let k = 0; k < steps; k++) curve[k] += readAt(scores[p], (pairs[p].at + (k * ALIGN_STEP_MS - ALIGN_RANGE_MS) / 1000) * fps);
    }
    for (let k = 0; k < steps; k++) curve[k] /= pairs.length;
    let peak = 0;
    for (let k = 1; k < steps; k++) if (curve[k] > curve[peak]) peak = k;
    const plateau = ALIGN_PLATEAU_SHARE * curve[peak];
    let first = peak;
    let last = peak;
    while (first > 0 && curve[first - 1] >= plateau) first--;
    while (last < steps - 1 && curve[last + 1] >= plateau) last++;
    const sorted = Float64Array.from(curve).sort();
    // The middle of the plateau, to the nearest 10 ms (and a plain 0, never -0).
    const middle = Math.round((((first + last) / 2) * ALIGN_STEP_MS - ALIGN_RANGE_MS) / 10) * 10;
    return {
        offsetMs: middle === 0 ? 0 : middle, score: curve[peak], contrast: curve[peak] - sorted[steps >> 1],
        plateauMs: (last - first) * ALIGN_STEP_MS, pairs: inside.length, spanMs,
    };
}

// Whether a measurement is clear enough to put in place of the default offset.
export function isConfidentAlignment(result: AlignResult): boolean {
    return result.score >= ALIGN_MIN_SCORE && result.contrast >= ALIGN_MIN_CONTRAST && result.plateauMs <= ALIGN_MAX_PLATEAU_MS
        && result.pairs >= ALIGN_MIN_PAIRS && result.spanMs >= ALIGN_MIN_SPAN_MS;
}

// How far from the default offset for its source a measured one may be and still be believed. The 30 clips measured on 2026-10-30 lie within
// about 0.6 s of their default, so a peak much further out (at the edge of the search range, an animal pacing to and fro) is not the clip's own.
export const ALIGN_MAX_DEVIATION_MS = 1_500;

export function isPlausibleOffset(offsetMs: number, defaultOffsetMs: number): boolean {
    return Math.abs(offsetMs - defaultOffsetMs) <= ALIGN_MAX_DEVIATION_MS;
}

// The offset for a clip, or undefined when the footage does not show it clearly (the default then stays).
export function estimateOffsetMs(video: GrayFrames, track: readonly TrackSample[], clipStartAt: number): AlignResult | undefined {
    const result = measureAlignment(video, track, clipStartAt);
    return result && isConfidentAlignment(result) ? result : undefined;
}
