/** Where the detector's boxes go on a visit's video. Plain maths with no page behind it, so each rule is held by a test (test/detections.test.mjs): which boxes
 * to draw at a moment of the video (`boxesAt`), what a box's label says (`boxLabel`), where the picture sits inside the video element (`containRect`) and which
 * part of a box may take a tap (`hitRect`). Drawing them is components/kestrel-detection-boxes.ts. */
import type { DetectionBox, DetectionFrame, Visit, VisitDetections } from "./types.ts";

/** A rectangle with its top-left corner at (x, y): in pixels, or for a box in shares (0..1) of the picture. */
export interface Rect { x: number; y: number; w: number; h: number }

/** Two detections further apart than this are two separate sightings: nothing is drawn between them. */
export const GAP_MS = 700;
/** How long a box is still drawn before the first detection and after the last (and next to a gap): the animal was there a moment ago. */
export const EDGE_MS = 400;
/** The strip along the bottom of the video where the browser draws its own controls: nothing in it takes a tap. Measured on Chromium's controls, phone and desktop
 * alike: the timeline takes the lowest 24 px, the buttons above it (48 px targets) reach up to 73 px, so a press that low is theirs. */
export const CONTROLS_PX = 76;

/** The moment of the video (ms from its first frame) that a detection belongs to: the video runs `offsetMs` behind the detector, so a positive offset is later. */
export const videoMsOf = (frameT: number, clipStartAt: number, offsetMs: number): number => frameT + offsetMs - clipStartAt;

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const word = (value: unknown): string | undefined => typeof value === "string" && value !== "" ? value : undefined;

function readBox(value: unknown): DetectionBox | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const { x, y, w, h, score } = raw;
  if (!finite(x) || !finite(y) || !finite(w) || !finite(h) || !finite(score) || w <= 0 || h <= 0) return null;
  const box: DetectionBox = { x, y, w, h, className: word(raw.className) ?? "animal", score };
  const id = word(raw.id);
  const label = word(raw.label);
  if (id) box.id = id;
  if (label) box.label = label;
  if (finite(raw.labelScore)) box.labelScore = raw.labelScore;
  return box;
}

/** What the server sent as a visit's `detections`, kept as far as it can be drawn: a frame or box that is damaged is left out, frames are put in time order, and
 * when no usable frame is left the answer is undefined. A damaged answer never reaches the page. */
export function readDetections(value: unknown): VisitDetections | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (!finite(raw.clipStartAt) || !finite(raw.offsetMs) || !Array.isArray(raw.frames)) return undefined;
  const frames: DetectionFrame[] = [];
  for (const item of raw.frames as unknown[]) {
    const frame = item && typeof item === "object" ? item as Record<string, unknown> : null;
    if (!frame || !finite(frame.t) || !Array.isArray(frame.boxes)) continue;
    const boxes = (frame.boxes as unknown[]).map(readBox).filter((box): box is DetectionBox => box !== null);
    if (boxes.length) frames.push({ t: frame.t, boxes });
  }
  return frames.length ? { clipStartAt: raw.clipStartAt, offsetMs: raw.offsetMs, frames: frames.sort((a, b) => a.t - b.t) } : undefined;
}

/** How far apart two boxes are, counted in the larger side of the two: 0 when they share a centre, 1 when the centres are a whole side apart. */
function apart(a: DetectionBox, b: DetectionBox): number {
  return Math.hypot(a.x + a.w / 2 - b.x - b.w / 2, a.y + a.h / 2 - b.y - b.h / 2) / Math.max(a.w, a.h, b.w, b.h);
}

/** For each box of `a` the index of the box of `b` that is the same animal, or -1. The detector's own id decides first; the boxes left over are paired closest
 * first, as long as the centres are less than a box apart (a bird that jumped further is two boxes, not one that glides across). */
function pair(a: DetectionBox[], b: DetectionBox[]): number[] {
  const taken: boolean[] = [];
  const partner = a.map((box) => {
    const at = box.id === undefined ? -1 : b.findIndex((other, j) => other.id === box.id && !taken[j]);
    if (at >= 0) taken[at] = true;
    return at;
  });
  const near: Array<[number, number, number]> = [];
  a.forEach((one, i) => { if (partner[i] < 0) b.forEach((two, j) => { const d = apart(one, two); if (!taken[j] && d <= 1) near.push([d, i, j]); }); });
  for (const [, i, j] of near.sort((p, q) => p[0] - q[0])) if (partner[i] < 0 && !taken[j]) { partner[i] = j; taken[j] = true; }
  return partner;
}

const mix = (from: number, to: number, at: number): number => from + (to - from) * at;

/** The boxes between two detections, `at` of the way from the first (0) to the second (1). An animal in both slides from one place to the other and takes its
 * label from the detection it is closer to. An animal in only one is drawn as that detection has it, for as long as that detection is the closer one. */
function blend(a: DetectionBox[], b: DetectionBox[], at: number): DetectionBox[] {
  const toB = pair(a, b);
  const out: DetectionBox[] = [];
  a.forEach((from, i) => {
    const to = b[toB[i]];
    if (to) out.push({ ...(at < 0.5 ? from : to), x: mix(from.x, to.x, at), y: mix(from.y, to.y, at), w: mix(from.w, to.w, at), h: mix(from.h, to.h, at) });
    else if (at < 0.5) out.push(from);
  });
  if (at >= 0.5) b.forEach((box, j) => { if (!toB.includes(j)) out.push(box); });
  return out;
}

/** The boxes to draw at `videoMs` (ms from the video's first frame). Between two detections that are close enough (`GAP_MS`) the boxes slide from one to the other;
 * with `interpolate: false` (reduced motion) the closer detection is drawn as it is, so boxes step instead of gliding. Where there is no detection near (further
 * than `EDGE_MS` from the closest one, which also holds before the first, after the last and across a long gap) nothing is drawn. The boxes of a detection are
 * returned as they are: do not change them. */
export function boxesAt({ clipStartAt, offsetMs, frames }: VisitDetections, videoMs: number, { interpolate }: { interpolate: boolean }): DetectionBox[] {
  const when = (i: number): number => videoMsOf(frames[i].t, clipStartAt, offsetMs);
  let low = 0;
  let high = frames.length;
  while (low < high) { // low ends as the first detection that comes after `videoMs`
    const middle = (low + high) >> 1;
    if (when(middle) <= videoMs) low = middle + 1;
    else high = middle;
  }
  const back = low > 0 ? videoMs - when(low - 1) : Infinity; // how long ago the detection before came
  const ahead = low < frames.length ? when(low) - videoMs : Infinity; // how soon the next one comes
  if (interpolate && back > 0 && back + ahead <= GAP_MS) return blend(frames[low - 1].boxes, frames[low].boxes, back / (back + ahead));
  return Math.min(back, ahead) <= EDGE_MS ? frames[back <= ahead ? low - 1 : low].boxes : [];
}

/** What a box's label says. A species the classifier named is shown as it is, with its confidence only when the classifier gave one: the detector's own score is
 * never put next to a species, where it would read as how sure the species is. A box with no species yet is "Animal 82%": the detector's class and its score. */
export function boxLabel({ className, score, label, labelScore }: Pick<DetectionBox, "className" | "score" | "label" | "labelScore">): string {
  const percent = (value: unknown): string => finite(value) ? ` ${Math.round(value * 100)}%` : "";
  return label ? `${label}${percent(labelScore)}` : `${className.charAt(0).toUpperCase()}${className.slice(1)}${percent(score)}`;
}

/** The part of an `object-fit: contain` video element that the picture fills: all of it when the shapes match, otherwise the picture is centred with empty bands
 * above and below (a wide element) or left and right (a tall one). null while either size is not known yet (0). */
export function containRect(boxW: number, boxH: number, videoW: number, videoH: number): Rect | null {
  if (!(boxW > 0 && boxH > 0 && videoW > 0 && videoH > 0)) return null;
  const scale = Math.min(boxW / videoW, boxH / videoH);
  const w = videoW * scale;
  const h = videoH * scale;
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h };
}

/** A box (shares of the picture) in the pixels of the video element, given where the picture sits in it. */
export const toPixels = (box: Rect, picture: Rect): Rect => ({ x: picture.x + box.x * picture.w, y: picture.y + box.y * picture.h, w: box.w * picture.w, h: box.h * picture.h });

const within = (value: number, low: number, high: number): number => Math.max(low, Math.min(value, high));

/** Where a label of `w` x `h` goes: sitting on the box's top edge, or just inside the top of the box when there is no room above it, and in both cases inside the picture.
 * A label that would run under `avoid` (the on/off button in the corner) moves left of it instead. */
export function placeLabel(box: Rect, w: number, h: number, picture: Rect, avoid: Rect | null = null): { x: number; y: number } {
  const above = box.y - h;
  const y = within(above >= picture.y ? above : box.y, picture.y, picture.y + picture.h - h);
  const x = within(box.x, picture.x, picture.x + picture.w - w);
  const under = avoid !== null && x < avoid.x + avoid.w && x + w > avoid.x && y < avoid.y + avoid.h && y + h > avoid.y;
  return { x: under ? Math.max(picture.x, avoid.x - w) : x, y };
}

/** The part of a box and its label that takes a tap: all of it except what lies outside the video element or in the strip at the bottom where the browser's own
 * controls are (`CONTROLS_PX`), so a press on a control still reaches it. null when nothing is left. */
export function hitRect(box: Rect, label: Rect, element: { w: number; h: number }): Rect | null {
  const left = Math.max(0, Math.min(box.x, label.x));
  const top = Math.max(0, Math.min(box.y, label.y));
  const right = Math.min(element.w, Math.max(box.x + box.w, label.x + label.w));
  const bottom = Math.min(element.h - CONTROLS_PX, Math.max(box.y + box.h, label.y + label.h));
  return right > left && bottom > top ? { x: left, y: top, w: right - left, h: bottom - top } : null;
}

/** The visit to show once `next` has arrived for the page that is showing `current`. A fresh answer for the same visit with no track of its own (one read from a
 * list, or an answer that could not read it) keeps the track already on screen, as long as its clip is still ready. */
export function keepTrack(current: Visit | null, next: Visit): Visit {
  const track = current?.id === next.id ? current.detections : undefined;
  return !track || next.detections || next.clip?.state !== "ready" ? next : { ...next, detections: track };
}
