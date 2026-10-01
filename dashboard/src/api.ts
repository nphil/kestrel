import { stableUrl } from "./urls.ts";
import type { Camera, Health, HomeAssistant, KestrelCardConfig, Settings, Species, SpeciesDetail, Visit, VisitPage, VisitQuery } from "./types.ts";

export function callWS<T>(hass: HomeAssistant, type: string, fields: Record<string, unknown> = {}): Promise<T> {
  return hass.callWS<T>({ type, ...fields });
}

export const api = {
  cameras: (hass: HomeAssistant) => callWS<Camera[] | { items: Camera[] }>(hass, "kestrel/cameras"),
  visits: (hass: HomeAssistant, query: VisitQuery = {}) => callWS<VisitPage>(hass, "kestrel/visits", query as Record<string, unknown>),
  // Never asks the server about a visit without an id: the command would be rejected and logged.
  visit: (hass: HomeAssistant, visitId: string) => visitId ? callWS<Visit>(hass, "kestrel/visit", { visit_id: visitId }) : Promise.reject(new Error("A visit id is required")),
  correct: (hass: HomeAssistant, visitId: string, species: string) => callWS<unknown>(hass, "kestrel/visit/correct", { visit_id: visitId, species }),
  confirm: (hass: HomeAssistant, visitId: string, alsoHeard = false) => callWS<unknown>(hass, "kestrel/visit/confirm", { visit_id: visitId, ...(alsoHeard ? { also_heard: true } : {}) }),
  undo: (hass: HomeAssistant, visitId: string) => callWS<unknown>(hass, "kestrel/visit/undo", { visit_id: visitId }),
  review: (hass: HomeAssistant) => callWS<VisitPage | Visit[]>(hass, "kestrel/review"),
  species: (hass: HomeAssistant) => callWS<Species[] | { items: Species[] }>(hass, "kestrel/species"),
  speciesDetail: (hass: HomeAssistant, name: string) => callWS<SpeciesDetail | Species>(hass, "kestrel/species/detail", { species: name }),
  labels: (hass: HomeAssistant) => callWS<unknown>(hass, "kestrel/labels"),
  health: (hass: HomeAssistant) => callWS<Health>(hass, "kestrel/health"),
  settings: (hass: HomeAssistant) => callWS<Settings>(hass, "kestrel/settings/get"),
  setSettings: (hass: HomeAssistant, settings: Settings) => callWS<Settings>(hass, "kestrel/settings/set", { settings }),
};

/** True when the server says the thing asked for isn't there (a merged or removed visit). */
export function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "not_found";
}

export function asArray<T>(value: unknown, key = "items"): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === "object") {
    const candidate = (value as Record<string, unknown>)[key];
    if (Array.isArray(candidate)) return candidate as T[];
  }
  return [];
}

/** Keeps a visit's picture, clip and recording links the same from one response to the next (see urls.ts). */
function steadyVisit(visit: Visit): Visit {
  if (visit.snapshot) visit.snapshot = stableUrl(visit.snapshot) as string;
  if (visit.crop) visit.crop = stableUrl(visit.crop) as string;
  if (visit.audio) visit.audio = stableUrl(visit.audio) as string;
  if (visit.audioOriginal) visit.audioOriginal = stableUrl(visit.audioOriginal) as string;
  if (visit.clip?.url) visit.clip.url = stableUrl(visit.clip.url) as string;
  return visit;
}

export function asVisit(value: unknown): Visit | null {
  if (!value || typeof value !== "object") return null;
  const outer = value as Record<string, unknown>;
  const candidate = outer.visit && typeof outer.visit === "object" ? outer.visit : outer;
  return steadyVisit(candidate as Visit);
}

export function visitPage(value: unknown): VisitPage {
  if (Array.isArray(value)) return { items: (value as Visit[]).map(steadyVisit) };
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    // The plugin's cursor is the last visit's start time (a number); the `before` filter takes it as text.
    const next = typeof record.next === "number" || typeof record.next === "string" ? String(record.next) : null;
    return { items: Array.isArray(record.items) ? (record.items as Visit[]).map(steadyVisit) : [], next };
  }
  return { items: [] };
}

function steadySpecies(species: Species): Species {
  if (species.photo_url) species.photo_url = stableUrl(species.photo_url) as string;
  if (species.photo) species.photo = stableUrl(species.photo) as string;
  if (species.image) species.image = stableUrl(species.image) as string;
  if (species.referenceImage) species.referenceImage = stableUrl(species.referenceImage) as string;
  return species;
}

export function speciesArray(value: unknown): Species[] {
  if (Array.isArray(value)) return (value as Species[]).map(steadySpecies);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.items)) return (record.items as Species[]).map(steadySpecies);
  if (Array.isArray(record.species)) return (record.species as Species[]).map(steadySpecies);
  return [];
}

export function extractLabels(value: unknown): string[] {
  const records = Array.isArray(value) ? value : value && typeof value === "object" ? ((value as Record<string, unknown>).labels ?? (value as Record<string, unknown>).items) : [];
  if (!Array.isArray(records)) return [];
  return records.map((item) => {
    if (typeof item === "string") return item;
    if (item && typeof item === "object") {
      const row = item as Record<string, unknown>;
      return typeof row.species === "string" ? row.species : typeof row.name === "string" ? row.name : "";
    }
    return "";
  }).filter(Boolean);
}

export function mediaUrl(value: string | null | undefined): string | null {
  if (!value || typeof value !== "string") return null;
  return value;
}

export function visitSnapshot(visit: Visit): string | null {
  return mediaUrl(visit.snapshot);
}

export function visitClip(visit: Visit): string | null {
  const clip = visit.clip as Visit["clip"] & { url?: string | null; media?: string | null };
  return mediaUrl(clip?.url ?? clip?.media ?? (visit as Visit & { clipUrl?: string }).clipUrl);
}

export function visitAudio(visit: Visit): string | null {
  return mediaUrl(visit.audio ?? visit.heard?.audio_url ?? visit.heard?.audio ?? null);
}

export function visitAudioOriginal(visit: { audioOriginal?: string | null }): string | null {
  return mediaUrl(visit.audioOriginal ?? null);
}

export function speciesPhoto(species: Species): string | null {
  return mediaUrl(species.photo_url ?? species.photo ?? species.image ?? null);
}

export function speciesReferencePhoto(detail: unknown, species?: Species): string | null {
  const item = detail && typeof detail === "object" ? detail as Record<string, unknown> : {};
  const nested = item.species && typeof item.species === "object" ? item.species as Record<string, unknown> : item;
  const direct = nested.referenceImage;
  return mediaUrl(typeof direct === "string" ? direct : species?.referenceImage ?? null);
}

/** The species' own photo if Kestrel has one, otherwise its reference photo; `isReference` says which. */
export function speciesPicture(species: Species): { url: string | null; isReference: boolean } {
  const own = speciesPhoto(species);
  if (own) return { url: own, isReference: false };
  const reference = speciesReferencePhoto(null, species);
  return { url: reference, isReference: reference !== null };
}

export function cameraSnapshotUrl(id: string | number): string | null {
  return mediaUrl(`media/camera/${id}.jpg`);
}

export function routeView(config: KestrelCardConfig): KestrelCardConfig["view"] {
  const path = window.location.pathname.replace(/\/+$/, "").split("/").pop();
  if (path === "visit" || path === "live" || path === "wildlife" || path === "insights") return path;
  return config.view ?? "live";
}

export function visitIdFromLocation(): string | null {
  return new URLSearchParams(window.location.search).get("v");
}

export function speciesFromLocation(): string | null {
  return new URLSearchParams(window.location.search).get("s");
}

/** How many history entries the panel itself has added since it was opened (Home Assistant's own entries
 * carry no state, so they count as 0). Back buttons use it to know whether going back stays in the panel. */
export function panelDepth(): number {
  const state = window.history.state as { kestrel?: unknown } | null;
  return typeof state?.kestrel === "number" ? state.kestrel : 0;
}

/** Moves within the panel: a new history entry, or with `replace` a swap of the current one. */
export function navigate(path: string, search = "", replace = false): void {
  const dashboardPath = window.location.pathname.split("/").filter(Boolean)[0] ?? "lovelace";
  const url = `/${dashboardPath}/${path}${search}`;
  if (replace) window.history.replaceState({ kestrel: panelDepth() }, "", url);
  else window.history.pushState({ kestrel: panelDepth() + 1 }, "", url);
  window.dispatchEvent(new Event("location-changed"));
}

/** Goes back one step inside the panel, or to `fallback` when this was the first screen. */
export function goBack(fallback: string, search = ""): void {
  if (panelDepth() > 0) window.history.back();
  else navigate(fallback, search, true);
}
