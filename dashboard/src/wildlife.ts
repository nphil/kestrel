import { timestamp } from "./format.ts";
import type { Camera, CameraDetection, Species, VisitKind } from "./types.ts";

export type SpeciesFilter = "all" | "seen" | "heard";

/** How long a camera's latest detection is still worth showing on its card. */
export const SIGHTING_WINDOW_MS = 24 * 3_600_000;

export function matchesFilter(species: Species, filter: SpeciesFilter): boolean {
  return filter === "all" || (filter === "seen" ? species.seen : species.heard);
}

export function filterCounts(list: Species[]): Record<SpeciesFilter, number> {
  return { all: list.length, seen: list.filter((species) => species.seen).length, heard: list.filter((species) => species.heard).length };
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
