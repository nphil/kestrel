/** The last picture we saw from each camera, so a tile or the focused view never starts from grey.
 *
 * One small canvas per camera, redrawn in place, so memory is bounded by the number of cameras
 * (a 640-wide frame is under 1 MB). Copying a frame takes about 0.1 ms, which is why this stays
 * synchronous: it runs inside click handlers and element teardown, where an async encode would
 * not be finished in time to be useful. */
export type PictureSource = HTMLVideoElement | HTMLImageElement;

interface Entry { ratio: number; canvas?: HTMLCanvasElement; at: number }

const MAX_WIDTH = 640;
const MAX_AGE_MS = 10 * 60_000;
const entries = new Map<string, Entry>();

/** Natural width and height of a playing video or loaded image. */
export function pictureSize(source: PictureSource): [number, number] {
  return source instanceof HTMLVideoElement ? [source.videoWidth, source.videoHeight] : [source.naturalWidth, source.naturalHeight];
}

/** Remember a camera's picture shape (width / height) even when no frame could be copied. */
export function noteRatio(id: string, width: number, height: number): void {
  if (!id || !width || !height) return;
  const entry = entries.get(id);
  if (entry) entry.ratio = width / height;
  else entries.set(id, { ratio: width / height, at: Date.now() });
}

/** Copy what a playing video (or a loaded image) is showing right now. Returns false if it had nothing to copy. */
export function captureFrame(id: string, source: PictureSource | null | undefined): boolean {
  if (!id || !source || (source instanceof HTMLVideoElement && source.readyState < 2)) return false;
  const [sourceWidth, sourceHeight] = pictureSize(source);
  if (!sourceWidth || !sourceHeight) return false;
  const scale = Math.min(1, MAX_WIDTH / sourceWidth);
  const width = Math.round(sourceWidth * scale);
  const height = Math.round(sourceHeight * scale);
  const now = Date.now();
  for (const [key, entry] of entries) if (key !== id && now - entry.at > MAX_AGE_MS) entries.delete(key);
  let entry = entries.get(id);
  if (!entry) { entry = { ratio: sourceWidth / sourceHeight, at: now }; entries.set(id, entry); }
  const canvas = entry.canvas ?? document.createElement("canvas");
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  try { canvas.getContext("2d")?.drawImage(source, 0, 0, width, height); } catch { return false; }
  entry.canvas = canvas;
  entry.ratio = sourceWidth / sourceHeight;
  entry.at = now;
  return true;
}

/** The cached picture for a camera, or null if there isn't one or it is too old to be worth showing. */
export function frameFor(id: string): HTMLCanvasElement | null {
  const entry = entries.get(id);
  return entry?.canvas && Date.now() - entry.at <= MAX_AGE_MS ? entry.canvas : null;
}

/** width / height of the camera's picture, if we have ever seen it. */
export function ratioFor(id: string): number | null {
  return entries.get(id)?.ratio ?? null;
}
