import { pluralize } from "./format.ts";
import type { Group, Visit, VisitKind } from "./types.ts";

/** The panel's one icon vocabulary. Each kind of evidence has exactly one icon and one word, and every
 * tile, chip, row, sheet and page draws it from here, so a sound recording never looks like a video. */
export const KIND = {
  seen: { icon: "mdi:video", word: "Video", verb: "Seen" },
  heard: { icon: "mdi:waveform", word: "Heard", verb: "Heard" },
} as const satisfies Record<VisitKind, { icon: string; word: string; verb: string }>;

export const GROUP_LABEL: Record<Group, string> = { bird: "Bird", mammal: "Mammal", other: "Wildlife", unknown: "Wildlife" };

export function asKind(value: unknown): VisitKind | null {
  return value === "seen" || value === "heard" ? value : null;
}

/** "Heard" for a recording, "Video" for a sighting with a clip (or one still being saved), "Photo" for one without. */
export function evidenceWord(visit: Pick<Visit, "kind" | "clip">): string {
  if (visit.kind === "heard") return KIND.heard.word;
  const state = visit.clip?.state;
  return state === "none" || state === "deleted" ? "Photo" : KIND.seen.word;
}

/** "0:03–0:08": a stretch of a recording, in minutes and seconds. */
export function span(start: number, end: number): string {
  const clock = (seconds: number): string => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
  return `${clock(Math.max(0, start))}–${clock(Math.max(0, end))}`;
}

/** What to tell the listener about a recording that has been prepared: whether it was cleaned, and which
 * moment of the clip it is. Nothing while it is still being prepared, so the swap from the original is silent. */
export function recordingNotes(info: Pick<NonNullable<Visit["audioInfo"]>, "state" | "segment" | "cleaned"> | null | undefined): { mark: string; caption: string } {
  if (!info || info.state !== "ready") return { mark: "", caption: "" };
  return { mark: info.cleaned ? "Cleaned" : "", caption: info.segment ? `Matched moment · ${span(info.segment.start, info.segment.end)}` : "" };
}

/** "12 videos" or "35 recordings". */
export function evidenceCount(kind: VisitKind, count: number): string {
  return pluralize(count, kind === "seen" ? "video" : "recording");
}
