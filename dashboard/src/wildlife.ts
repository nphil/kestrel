import { timestamp } from "./format.ts";
import { DEFAULT_PERIOD, PERIOD_PHRASE, asPeriod, type SpeciesPeriod } from "./period.ts";
import type { Camera, CameraDetection, Species, VisitKind } from "./types.ts";

export type SpeciesFilter = "all" | "seen" | "heard";

/** How long a camera's latest detection is still worth showing on its card. */
export const SIGHTING_WINDOW_MS = 24 * 3_600_000;

const whole = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;

/** Does the species belong under this filter? Inside a period "on camera" means seen in that period, not ever, when the server counted them. */
export function matchesFilter(species: Species, filter: SpeciesFilter, period: SpeciesPeriod = "all"): boolean {
  if (filter === "all") return true;
  const own = period === "all" ? undefined : whole(filter === "seen" ? species.periodSeen : species.periodHeard);
  return own !== undefined ? own > 0 : filter === "seen" ? species.seen : species.heard;
}

export function filterCounts(list: Species[], period: SpeciesPeriod = "all"): Record<SpeciesFilter, number> {
  return { all: list.length, seen: list.filter((species) => matchesFilter(species, "seen", period)).length, heard: list.filter((species) => matchesFilter(species, "heard", period)).length };
}

/** The species that had a visit in the period. `all` is the whole list. */
export function inPeriod(list: Species[], period: SpeciesPeriod): Species[] {
  return period === "all" ? list : list.filter((species) => (whole(species.periodCount) ?? 0) > 0);
}

/** What a tile counts for one kind: the period's own number when the server sent it, otherwise the last 30 days'. */
export function tileCount(species: Species, kind: VisitKind): number | undefined {
  return whole(kind === "seen" ? species.periodSeen : species.periodHeard) ?? whole(kind === "seen" ? species.seenCount30d : species.heardCount30d);
}

/** The badges on a tile: one per kind the species has in the period, with its count. */
export function tileEvidence(species: Species, period: SpeciesPeriod): Array<{ kind: VisitKind; count: number | undefined }> {
  const kinds: VisitKind[] = ["seen", "heard"];
  return kinds.filter((kind) => matchesFilter(species, kind, period)).map((kind) => ({ kind, count: tileCount(species, kind) }));
}

/** What the Wildlife list says when nothing matches. `action` is the one useful next step: look further back, or stop narrowing by kind. */
export interface EmptyCopy { kind: VisitKind | "any"; heading: string; message: string; action: "all-time" | "all-species" | null }

export function emptyWildlife(period: SpeciesPeriod, filter: SpeciesFilter): EmptyCopy {
  const kind = filter === "all" ? "any" : filter;
  if (period === "all") {
    if (filter === "seen") return { kind, heading: "Nothing on camera yet", message: "When a camera catches an animal, it shows up here with its video.", action: "all-species" };
    if (filter === "heard") return { kind, heading: "Nothing heard yet", message: "Sounds picked up by BirdNET-Go show up here with their recordings.", action: "all-species" };
    return { kind, heading: "No wildlife visits yet", message: "Identified birds and animals will appear here with their videos and recordings.", action: null };
  }
  const phrase = PERIOD_PHRASE[period];
  if (filter === "seen") return { kind, heading: `Nothing on camera ${phrase}`, message: `No camera caught an animal ${phrase}.`, action: "all-time" };
  if (filter === "heard") return { kind, heading: `Nothing heard ${phrase}`, message: `No sounds were picked up ${phrase}.`, action: "all-time" };
  return { kind, heading: `No wildlife ${phrase}`, message: `No animals were seen or heard ${phrase}.`, action: "all-time" };
}

/** The latest thing that happened to a species, so its tile can say "Heard 3 min ago". `kind` is null when it
 * can't be told (the plugin hasn't sent per-kind times, and the species has been both seen and heard). */
export interface Activity { kind: VisitKind | null; at: number; camera: string | null }

function idOf(value: string | number | null | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

function soleCamera(species: Species): string | null {
  const ids = Object.keys(species.cameras ?? {});
  return ids.length === 1 ? ids[0] : null;
}

export function lastActivity(species: Species): Activity | null {
  const seenAt = timestamp(species.lastSeenAt);
  const heardAt = timestamp(species.lastHeardAt);
  if (seenAt !== null || heardAt !== null) {
    const kind: VisitKind = (seenAt ?? -Infinity) >= (heardAt ?? -Infinity) ? "seen" : "heard";
    const camera = idOf(kind === "seen" ? species.lastSeenCamera : species.lastHeardCamera) ?? soleCamera(species);
    return { kind, at: kind === "seen" ? seenAt as number : heardAt as number, camera };
  }
  const at = timestamp(species.last);
  if (at === null) return null;
  const kind = species.seen && !species.heard ? "seen" : species.heard && !species.seen ? "heard" : null;
  return { kind, at, camera: soleCamera(species) };
}

/** A camera's latest detection, if it is recent enough and can be opened. */
export function recentSighting(camera: Camera, now = Date.now()): CameraDetection | null {
  const detection = camera.lastDetection;
  if (!detection?.species || !detection.visitId) return null;
  const at = timestamp(detection.at);
  return at !== null && now - at <= SIGHTING_WINDOW_MS ? detection : null;
}

const FILTER_KEY = "kestrel.wildlife.filter";

function readFilter(): SpeciesFilter {
  try {
    const stored = window.sessionStorage.getItem(FILTER_KEY);
    return stored === "seen" || stored === "heard" ? stored : "all";
  } catch { return "all"; }
}

let remembered: SpeciesFilter | undefined;

/** The Wildlife filter the user last chose, kept for the browser session. */
export function rememberedFilter(): SpeciesFilter {
  remembered ??= readFilter();
  return remembered;
}

export function rememberFilter(filter: SpeciesFilter): void {
  remembered = filter;
  try { window.sessionStorage.setItem(FILTER_KEY, filter); } catch { /* the choice still holds for this page */ }
}

const PERIOD_KEY = "kestrel.wildlife.period";

function readPeriod(): SpeciesPeriod {
  try { return asPeriod(window.sessionStorage.getItem(PERIOD_KEY)); } catch { return DEFAULT_PERIOD; }
}

let rememberedChoice: SpeciesPeriod | undefined;

/** The stretch of time the Wildlife list looks at, as the user last chose it, kept for the browser session like the filter. */
export function rememberedPeriod(): SpeciesPeriod {
  rememberedChoice ??= readPeriod();
  return rememberedChoice;
}

export function rememberPeriod(period: SpeciesPeriod): void {
  rememberedChoice = period;
  try { window.sessionStorage.setItem(PERIOD_KEY, period); } catch { /* the choice still holds for this page */ }
}
