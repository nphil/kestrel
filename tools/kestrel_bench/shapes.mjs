// The shapes of the two things Kestrel listens to, built the way the real senders build them. Pure functions, no I/O: the bench (sandbox.mjs)
// feeds them to the plugin's own readers, and test/shapes.test.mjs checks that those readers understand every one.
//
//   birdnetMessage(...)  one BirdNET-Go MQTT message (PascalCase, Date + Time as separate wall-clock strings, `Model` as a nested object
//                        or flat `modelName` / `modelVersion`, `occurrence` left out when it is not known, the clip's file name)
//   detectionEvent(...)  one Scrypted ObjectsDetected event (pixel boxes in the picture the detector looked at)
//   walkTrack(...)       the events of an animal walking across a camera's picture, one every 250 ms

/** The models BirdNET-Go can name in a message, in both spellings it has used. */
export const MODELS = {
  v3: { nested: { Name: "BirdNET", Version: "3.0", Variant: "default" }, flat: { modelName: "BirdNET", modelVersion: "3.0" } },
  perch: { nested: { Name: "Perch", Version: "V2", Variant: "default" }, flat: { modelName: "Perch", modelVersion: "V2" } },
  v24: { nested: { Name: "BirdNET", Version: "2.4", Variant: "default" }, flat: { modelName: "BirdNET", modelVersion: "2.4" } },
  // A message that says nothing about its model: an unrated source.
  none: null,
};

/** The chance BirdNET-Go gives a bird this week: "common" and "rare" are on either side of the plugin's 0.1 line, "unknown" leaves the field out. */
export const OCCURRENCE = { common: 0.62, uncommon: 0.2, rare: 0.04, unknown: null };

export const BIRDNET_TIME_ZONE = "America/New_York";

const pad = (value) => String(value).padStart(2, "0");

/** A moment as BirdNET-Go's wall-clock `Date` ("2026-11-14"), `Time` ("18:54:00") and the clip-name stamp ("20261114T185402Z"). */
export function wallClock(at, timeZone = BIRDNET_TIME_ZONE) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(at)).map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}:${parts.second}`, stamp: `${parts.year}${parts.month}${parts.day}T${parts.hour}${parts.minute}${parts.second}Z` };
}

/** BirdNET-Go's file name for a detection's recording: `<scientific_name>_<percent>p_<stamp>.opus` (the stamp is wall-clock time, whatever its `Z` says). */
export function clipNameFor(scientificName, confidence, at, timeZone = BIRDNET_TIME_ZONE) {
  return `${scientificName.toLowerCase().replace(/[^a-z]+/g, "_")}_${Math.round(confidence * 100)}p_${wallClock(at + 2000, timeZone).stamp}.opus`;
}

/**
 * One BirdNET-Go MQTT message.
 *   model       "v3" | "perch" | "v24" | "none"      style  "nested" (`Model: { Name, Version }`, BirdNET-Go 20260823) | "flat" (`modelName`, `modelVersion`)
 *   occurrence  a number 0-1 or null: null leaves the field out, as BirdNET-Go does when it is 0
 *   detectionId BirdNET-Go's number for the detection (it sometimes announces 0 with a real clip name); undefined leaves the field out
 *   clipName    undefined makes the usual name; null leaves the field out
 *   unlikely    true adds BirdNET-Go's `unlikely` tag (every hit looked like not a real call of the species); false leaves the field out, as BirdNET-Go does
 */
export function birdnetMessage({ commonName, scientificName, confidence, at, source, model = "v3", style = "nested", occurrence = OCCURRENCE.common, detectionId, clipName, unlikely = false, timeZone = BIRDNET_TIME_ZONE }) {
  const { date, time } = wallClock(at, timeZone);
  const message = {
    CommonName: commonName,
    ScientificName: scientificName,
    Confidence: Math.round(confidence * 100) / 100,
    Date: date,
    Time: time,
    timezone: timeZone,
    SourceName: source,
  };
  if (detectionId !== undefined) message.DetectionID = detectionId;
  const clip = clipName === undefined ? clipNameFor(scientificName, confidence, at, timeZone) : clipName;
  if (clip !== null) message.ClipName = clip;
  const modelInfo = MODELS[model];
  if (modelInfo === undefined) throw new Error(`Unknown model "${model}" (v3, perch, v24, none)`);
  if (modelInfo) {
    if (style === "flat") Object.assign(message, modelInfo.flat);
    else message.Model = { ...modelInfo.nested };
  }
  if (occurrence !== null && occurrence !== undefined) message.occurrence = occurrence;
  if (unlikely) message.unlikely = true;
  return message;
}

const round = (value, scale = 1000) => Math.round(value * scale) / scale;

/**
 * One Scrypted detection event. `animals` are boxes as shares of the picture (top-left origin): { id, x, y, w, h, score, label?, labelScore? }.
 * The event carries them as pixel boxes `[x, y, width, height]` in the picture the detector looked at (`inputDimensions`).
 */
export function detectionEvent({ t, inputDimensions = [640, 360], animals, detectionId }) {
  const [width, height] = inputDimensions;
  const event = {
    timestamp: t,
    inputDimensions,
    detections: animals.map((animal) => {
      const detection = { className: "animal", score: animal.score, id: animal.id, boundingBox: [round(animal.x * width, 10), round(animal.y * height, 10), round(animal.w * width, 10), round(animal.h * height, 10)] };
      if (animal.label) detection.label = animal.label;
      if (animal.labelScore !== undefined) detection.labelScore = animal.labelScore;
      return detection;
    }),
  };
  if (detectionId !== undefined) event.detectionId = detectionId;
  return event;
}

/**
 * The events of an animal walking across the picture left to right and bobbing a little, one every `stepMs`, `durationMs` long. It is just "an animal"
 * until `labelAtMs`, then the classifier names it (`labelScore` only when given: Scrypted's NVR almost never passes it on). A second, smaller animal the
 * classifier never names stands at the lower left in the middle of the walk. `ratio` is the picture's width over its height, so a box has the same
 * shape on a 16:9, a 4:3 and a portrait camera. The first event is at `startAt`.
 */
export function walkTrack({ startAt, ratio = 16 / 9, label, labelScore, labelAtMs = 1000, durationMs = 2750, stepMs = 250, second = true, detectionId = "bench-animal", inputDimensions }) {
  const size = inputDimensions ?? (ratio >= 1 ? [640, Math.round(640 / ratio)] : [Math.round(640 * ratio), 640]);
  const width = round((0.42 * 0.9) / ratio);
  const events = [];
  for (let at = 0; at <= durationMs; at += stepMs) {
    const progress = at / durationMs;
    const walker = { id: detectionId, x: round(0.04 + (0.92 - width) * progress), y: round(0.34 + 0.06 * Math.sin(progress * Math.PI * 2)), w: width, h: 0.42, score: round(0.92 - 0.1 * progress, 100) };
    if (at >= labelAtMs && label) {
      walker.label = label;
      if (labelScore !== undefined) walker.labelScore = labelScore;
    }
    const animals = [walker];
    if (second && at >= durationMs * 0.55 && at <= durationMs * 0.9) animals.push({ id: `${detectionId}-2`, x: 0.03, y: 0.62, w: round(width * 0.6), h: 0.3, score: 0.64 });
    events.push(detectionEvent({ t: startAt + at, inputDimensions: size, animals, detectionId }));
  }
  return events;
}
