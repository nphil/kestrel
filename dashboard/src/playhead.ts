/** The parts of an audio element the playhead needs (a real `HTMLAudioElement` has them all). */
export interface PlayingMedia { currentSrc?: string; src?: string; currentTime: number; duration: number; ended: boolean }

/** Where a recording's address leads, without its host or its signature: two links to the same recording have the same path. */
export function audioPath(src: string | null | undefined): string {
  if (!src) return "";
  try {
    return new URL(src, "http://kestrel.invalid").pathname;
  } catch {
    return "";
  }
}

/** The paths of the addresses a recording can play from (its own and its fallback), for `playheadAt`. */
export function audioPaths(...sources: Array<string | null | undefined>): string[] {
  return [...new Set(sources.map(audioPath).filter(Boolean))];
}

/** How far through a recording playback is, from 0 to 1 (0 while its length is not known). */
export function playedFraction(time: number, duration: number): number {
  return Number.isFinite(time) && Number.isFinite(duration) && duration > 0 ? Math.min(1, Math.max(0, time / duration)) : 0;
}

function plays(audio: PlayingMedia, paths: readonly string[]): boolean {
  return paths.includes(audioPath(audio.currentSrc || audio.src));
}

/** Which element a spectrogram follows, and how far it has played. `active` is the one element playing right now (there is only ever one); `previous` is the
 * one this spectrogram followed a moment ago.
 *
 * - `active` plays this recording: follow it.
 * - Nothing plays, but `previous` is still this recording and has not ended: it was paused, so the playhead stays where it stopped.
 * - Anything else (another recording took over, the source was removed, it ended): the playhead goes back to the start. */
export function playheadAt<T extends PlayingMedia>(previous: T | null, active: T | null, paths: readonly string[]): { audio: T | null; fraction: number } {
  if (active && plays(active, paths)) return { audio: active, fraction: playedFraction(active.currentTime, active.duration) };
  if (!active && previous && !previous.ended && plays(previous, paths)) return { audio: previous, fraction: playedFraction(previous.currentTime, previous.duration) };
  return { audio: null, fraction: 0 };
}
