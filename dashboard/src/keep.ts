import type { KeptRecording } from "./types.ts";

/** What `kestrel/recording/keep/get` and `/set` said, whatever it sent: only a real `true` counts, so a strange answer never shows a recording as kept. */
export function keptRecording(value: unknown): KeptRecording {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const keepable = raw.keepable === true;
  return { keepable, kept: keepable && raw.kept === true, canChange: raw.canChange === true };
}

/** The line under the "Keep recording" control. It always says what keeping does; only a failure or a missing permission replaces it. */
export function keepCaption(state: KeptRecording, failed: boolean): string {
  if (failed) return "Couldn't change this recording. Try again.";
  if (!state.canChange) return "Kept recordings are never deleted automatically. Only an administrator can keep one.";
  return "Kept recordings are never deleted automatically";
}
