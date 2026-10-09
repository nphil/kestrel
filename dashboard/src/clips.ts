/** Deleting saved camera clips: the choices, and the words used for them (one place, so the settings sheet and a visit page say the same thing). */
import { formatBytes, pluralize } from "./format.ts";

/** "Delete clips older than…": how far back to keep. */
export const AGE_CHOICES = [
  { months: 1, value: "1", label: "1 month" },
  { months: 3, value: "3", label: "3 months" },
  { months: 6, value: "6", label: "6 months" },
  { months: 12, value: "12", label: "1 year" },
] as const;

/** The moment `months` calendar months before `now`, in milliseconds. */
export function cutoff(months: number, now = Date.now()): number {
  const date = new Date(now);
  date.setMonth(date.getMonth() - months);
  return date.getTime();
}

/** "1 clip", "48 clips". */
export const clipCount = (count: number): string => pluralize(count, "clip");

/** The question before a delete: names how many clips, and says what stays. `bytes` is left out when it is not known (one visit's clip). */
export function confirmQuestion(count: number, bytes: number | null): { question: string; about: string } {
  const size = bytes === null ? "" : ` This frees about ${formatBytes(bytes)}.`;
  return {
    question: `Delete ${clipCount(count)}?${size}`,
    about: `Photos and visits are kept. Only the video is removed, and it can't be brought back.`,
  };
}

/** What happened: "Deleted 48 clips, freed 210 MB". */
export const resultLine = (deleted: number, freedBytes: number): string =>
  deleted === 0 ? "No clips were deleted." : `Deleted ${clipCount(deleted)}, freed ${formatBytes(freedBytes)}`;

/** What went wrong, in words for the person who pressed the button. */
export function clipFailure(error: unknown, fallback = "Kestrel couldn't reach its camera recorder."): string {
  if (typeof error !== "object" || error === null) return fallback;
  if ("code" in error && error.code === "unauthorized") return "Only a Home Assistant administrator can delete clips.";
  const message = "message" in error && typeof error.message === "string" ? error.message.trim() : "";
  return message ? (/[.!?]$/.test(message) ? message : `${message}.`) : fallback;
}
