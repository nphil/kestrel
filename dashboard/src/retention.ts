/** Bird recordings: how long BirdNET-Go keeps them and how full the storage they are saved to is, and the words used for both (one place, so the settings sheet and its tests say the same thing). */
import { formatBytes, pluralize } from "./format.ts";
import type { RecordingRetention, RetentionChoice, RetentionStorage } from "./types.ts";

/** The first question: keep recordings for a set time, or as long as there is room. */
export const MODE_OPTIONS = [
  { value: "time", label: "For a set time" },
  { value: "space", label: "Until space runs low" },
] as const;

/** The second question, for a set time: how long. */
export const DAY_OPTIONS = [
  { value: "30", label: "30 days" },
  { value: "60", label: "60 days" },
  { value: "90", label: "90 days" },
] as const;

type Keep = RecordingRetention["keep"];

/** Which of the two ways is chosen: `""` when BirdNET-Go is set to something Kestrel does not offer, so neither is marked. */
export function modeOf(keep: Keep): string {
  return keep === "space" ? "space" : keep === "30" || keep === "60" || keep === "90" ? "time" : "";
}

/** What "For a set time" means when it is pressed: the age BirdNET-Go already has, if that is one of the choices, otherwise 30 days. */
export function timeChoice(retention: RecordingRetention): RetentionChoice {
  return DAY_OPTIONS.find((option) => Number(option.value) === retention.days)?.value ?? "30";
}

const count = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null);
const percent = (value: unknown, fallback: number): number => (typeof value === "number" && value > 0 && value <= 100 ? Math.round(value) : fallback);
const KEEPS: readonly Keep[] = ["30", "60", "90", "space", "off", "other"];

/** What `kestrel/recording_retention/get` and `/set` said, whatever it sent: a figure that makes no sense is left out, so a strange answer never shows a wrong number,
 * and only a real `true` lets the person change it. The two percentages are the integration's own (85 and 90); they are only used when it does not say. */
export function recordingRetention(value: unknown): RecordingRetention {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const space = raw.storage && typeof raw.storage === "object" ? (raw.storage as Record<string, unknown>) : {};
  const used = count(space.usedBytes);
  const total = count(space.totalBytes);
  return {
    keep: KEEPS.find((keep) => keep === raw.keep) ?? "other",
    days: count(raw.days) || null,
    spacePercent: percent(raw.spacePercent, 85),
    guardPercent: percent(raw.guardPercent, 90),
    storage: used !== null && total ? { usedBytes: used, totalBytes: total } : null,
    kept: count(raw.kept),
    minClips: count(raw.minClips),
    checkMinutes: count(raw.checkMinutes) || null,
    canChange: raw.canChange === true,
  };
}

/** A size for this section: "4.2 GB", "30 GB" (a whole number of gigabytes has no ".0"). */
const size = (bytes: number): string => formatBytes(bytes).replace(".0 ", " ");

/** How full the storage is, in whole percent (never rounded up, so 100 only means full). */
export const fullPercent = (storage: RetentionStorage): number => Math.min(100, Math.floor((100 * storage.usedBytes) / storage.totalBytes));

/** The storage line, in two parts so the amount used can stand out: "4.2 GB" and "of 30 GB used · 14% full". */
export function spaceLine(storage: RetentionStorage): { used: string; rest: string } {
  return { used: size(storage.usedBytes), rest: `of ${size(storage.totalBytes)} used · ${fullPercent(storage)}% full` };
}

/** What is said about the recordings that were kept for good, or null when BirdNET-Go could not count them. */
export function keptLine(kept: number | null): string | null {
  if (kept === null) return null;
  return kept === 0
    ? "No recordings kept yet. A recording you keep is never removed."
    : `${pluralize(kept, "recording")} you've kept ${kept === 1 ? "is" : "are"} never removed.`;
}

/** What the chosen way of keeping recordings does, in plain words: a bold lead-in and the sentence after it. */
export function keepAbout(retention: RecordingRetention, keep: Keep): { lead: string; text: string } {
  const never = "Recordings you keep are never removed.";
  if (keep === "space") {
    return { lead: "Until space runs low.", text: `Recordings stay as long as there is room. Once the storage is ${retention.spacePercent}% full, the oldest are removed first, until it is below that again. ${never}` };
  }
  if (keep === "off") {
    return { lead: "Nothing is removed.", text: "BirdNET-Go isn't removing old recordings, so the storage will fill up. Choose an option above to turn the clean-up on." };
  }
  if (keep === "other") {
    return { lead: "Custom.", text: "BirdNET-Go is set to a rule that Kestrel doesn't offer. Choose an option above to change it." };
  }
  return { lead: `${keep} days.`, text: `Recordings older than ${keep} days are removed, oldest first. ${never}` };
}

/** Said under a time limit: what keeps it from filling the storage. */
export const guardNote = (retention: RecordingRetention): string =>
  `If the storage reaches ${retention.guardPercent}% full, Kestrel switches to “Until space runs low” by itself, to keep it from filling up.`;

/** Shown when the storage is nearly full, or null. What it adds depends on how recordings are kept. */
export function spaceWarning(retention: RecordingRetention, keep: Keep): string | null {
  const { storage, guardPercent } = retention;
  if (storage === null || fullPercent(storage) < guardPercent) return null;
  const full = `The storage is ${fullPercent(storage)}% full.`;
  const mode = modeOf(keep);
  if (mode === "time") return `${full} Kestrel switches to “Until space runs low” as soon as it next checks.`;
  return mode === "space" ? `${full} BirdNET-Go removes the oldest recordings first, but never ones you've kept.` : full;
}

/** The question before a change that could remove recordings the present setting would keep, or null when it cannot: a shorter time than now, any time after "until space
 * runs low" or a rule Kestrel doesn't offer, or "until space runs low" while the storage is already past its limit. */
export function removalQuestion(retention: RecordingRetention, keep: RetentionChoice): { question: string; about: string; button: string } | null {
  const soon = retention.checkMinutes === null ? "soon" : `within ${pluralize(retention.checkMinutes, "minute")}`;
  const after = "Recordings you keep are never removed. Removed recordings can't be brought back.";
  if (keep === "space") {
    const full = retention.storage === null ? 0 : fullPercent(retention.storage);
    if (retention.keep === "space" || full < retention.spacePercent) return null;
    return { question: "Remove the oldest recordings?", about: `The storage is ${full}% full. BirdNET-Go starts ${soon} and removes the oldest recordings until it is below ${retention.spacePercent}%. ${after}`, button: "Remove oldest recordings" };
  }
  if (Number(keep) >= Number(retention.keep)) return null; // not shorter (and Number("space") is NaN, so those always ask)
  return { question: `Remove recordings older than ${keep} days?`, about: `BirdNET-Go starts ${soon}, oldest first. ${after}`, button: "Remove older recordings" };
}

/** The small print: how often BirdNET-Go tidies up, and what it always leaves. */
export function tidyNote(retention: RecordingRetention): string | null {
  const { checkMinutes, minClips } = retention;
  const often = checkMinutes === null ? "" : ` every ${checkMinutes === 1 ? "minute" : `${checkMinutes} minutes`}`;
  const leaves = minClips === null || minClips === 0 ? "" : ` and always leaves at least ${pluralize(minClips, "recording")} of each species`;
  return often || leaves ? `BirdNET-Go tidies up${often}${leaves}.` : null;
}
