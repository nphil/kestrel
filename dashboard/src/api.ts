import { pathOf, stableUrl } from "./urls.ts";
import type { Camera, ClipChoice, ClipDeleteResult, ClipStorage, ClipTotals, Health, HomeAssistant, KestrelCardConfig, PhotoCredit, RangeFilter, ReferenceClip, ReferenceSounds, Settings, Species, SpeciesDetail, Visit, VisitPage, VisitQuery } from "./types.ts";

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
  // The server's raw answer: `referenceSounds()` makes it safe to use.
  speciesReference: (hass: HomeAssistant, species: string) => callWS<unknown>(hass, "kestrel/species/reference", { species }),
  labels: (hass: HomeAssistant) => callWS<unknown>(hass, "kestrel/labels"),
  health: (hass: HomeAssistant) => callWS<Health>(hass, "kestrel/health"),
  settings: (hass: HomeAssistant) => callWS<Settings>(hass, "kestrel/settings/get"),
  setSettings: (hass: HomeAssistant, settings: Settings) => callWS<Settings>(hass, "kestrel/settings/set", { settings }),
  rangeFilter: (hass: HomeAssistant) => callWS<RangeFilter>(hass, "kestrel/range_filter/get"),
  setRangeFilter: (hass: HomeAssistant, threshold: number) => callWS<RangeFilter>(hass, "kestrel/range_filter/set", { threshold }),
  /** Camera clips kept, and their size. With `olderThan` (milliseconds) only those from before it: what "delete older than..." would remove. */
  clipStorage: async (hass: HomeAssistant, olderThan?: number): Promise<ClipStorage> => clipStorage(await callWS<unknown>(hass, "kestrel/clips/storage", olderThan === undefined ? {} : { older_than: olderThan })),
  /** Administrators only. Photos and visits stay; only the video goes. */
  deleteClips: async (hass: HomeAssistant, choice: ClipChoice): Promise<ClipDeleteResult> => {
    const raw = await callWS<unknown>(hass, "kestrel/clips/delete", choice as unknown as Record<string, unknown>);
    const answer = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    return { deleted: count(answer.deleted), freedBytes: count(answer.freedBytes) };
  },
};

/** True when the server says the thing asked for isn't there (a merged or removed visit). */
export function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "not_found";
}

const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
const clipTotals = (value: unknown): ClipTotals => {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return { count: count(raw.count), bytes: count(raw.bytes) };
};

/** What `kestrel/clips/storage` said, whatever it sent: numbers that are missing are zero, never a crash. */
export function clipStorage(value: unknown): ClipStorage {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const reasons = raw.byReason && typeof raw.byReason === "object" ? raw.byReason as Record<string, unknown> : {};
  const oldest = typeof raw.oldestAt === "number" && Number.isFinite(raw.oldestAt) && raw.oldestAt > 0 ? raw.oldestAt : null;
  return { ...clipTotals(raw), oldestAt: oldest, byReason: { notAnimal: clipTotals(reasons.notAnimal), unconfirmed: clipTotals(reasons.unconfirmed) }, canDelete: raw.canDelete === true };
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

/** The species record inside a `kestrel/species/detail` answer (the answer itself when it is not nested). */
export function speciesRecord(detail: unknown): Record<string, unknown> {
  const item = detail && typeof detail === "object" ? detail as Record<string, unknown> : {};
  return item.species && typeof item.species === "object" ? item.species as Record<string, unknown> : item;
}

export function speciesReferencePhoto(detail: unknown, species?: Species): string | null {
  const direct = speciesRecord(detail).referenceImage;
  return mediaUrl(typeof direct === "string" ? direct : species?.referenceImage ?? null);
}

/** The species' own photo if Kestrel has one, otherwise its reference photo; `isReference` says which. */
export function speciesPicture(species: Species): { url: string | null; isReference: boolean } {
  const own = speciesPhoto(species);
  if (own) return { url: own, isReference: false };
  const reference = speciesReferencePhoto(null, species);
  return { url: reference, isReference: reference !== null };
}

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** What the server said about who took a reference photo; null when there is nothing to show. A page that is not an https link is dropped. */
export function photoInfo(value: unknown): PhotoCredit | null {
  const raw = (value ?? {}) as Record<string, unknown>; // a number or a string has none of these fields either
  const page = text(raw.page);
  const info = { source: text(raw.source), credit: text(raw.credit), licence: text(raw.licence), page: page.startsWith("https://") ? page : "" };
  return info.source || info.credit || info.licence ? info : null;
}

const credits = new Map<string, PhotoCredit>();

/** Asks once per photo (kept by path, whatever the signature) who took it. Never throws: 204, an error or an answer that cannot be read is null,
 * and only a credit is kept, so a photo the server did not know yet is asked about again next time. */
export async function loadPhotoCredit(url: string): Promise<PhotoCredit | null> {
  const key = pathOf(url);
  const kept = credits.get(key);
  if (kept) return kept;
  try {
    const response = await fetch(url);
    const info = response.status === 200 ? photoInfo(await response.json()) : null;
    if (info) credits.set(key, info);
    return info;
  } catch {
    return null;
  }
}

function referenceClip(value: unknown): ReferenceClip | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const id = text(raw.id);
  const url = text(raw.url);
  // A bare path the integration has not signed would resolve under the panel's own address and never play.
  if (!id || !/^(?:https?:)?\/\/|^\//.test(url)) return null;
  const page = text(raw.page);
  return {
    id,
    kind: raw.kind === "song" || raw.kind === "call" ? raw.kind : "other",
    label: text(raw.label) || "Recording",
    source: raw.source as ReferenceClip["source"],
    sourceName: text(raw.sourceName),
    credit: text(raw.credit),
    licence: text(raw.licence),
    quality: text(raw.quality) || null,
    seconds: typeof raw.seconds === "number" && Number.isFinite(raw.seconds) && raw.seconds > 0 ? raw.seconds : null,
    // The page is offered as a link: only a web address is taken, never a script.
    page: /^https?:\/\//i.test(page) ? page : "",
    url: stableUrl(url) as string,
  };
}

/** What the server said about a species' reference recordings, whatever it sent. An answer that cannot be read, or says `ready` without a
 * clip that can be played, is `unavailable` (try again), never a crash. Each clip keeps the same link from one response to the next (see urls.ts). */
export function referenceSounds(value: unknown): ReferenceSounds {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const clips = raw.state === "ready" && Array.isArray(raw.clips) ? raw.clips.map(referenceClip).filter((clip): clip is ReferenceClip => clip !== null) : [];
  const state = raw.state === "none" ? "none" : raw.state === "ready" && clips.length ? "ready" : "unavailable";
  return { species: text(raw.species), scientific: text(raw.scientific) || null, state, clips };
}

/** Keeps a camera's picture link the same from one response to the next (see urls.ts). */
function steadyCamera(camera: Camera): Camera {
  if (camera.picture) camera.picture = stableUrl(camera.picture) as string;
  return camera;
}

export function cameraArray(value: unknown): Camera[] {
  return asArray<Camera>(value).map(steadyCamera);
}

/** The link to a camera's current picture, or null when it has none or it isn't a usable link yet: a bare path the
 * integration hasn't signed would resolve under the panel's own address and never load. */
export function cameraPicture(camera: Camera): string | null {
  const link = camera.picture;
  return typeof link === "string" && /^(?:https?:)?\/\/|^\//.test(link) ? link : null;
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

/** The first part of the address, `/kestrel` for the sidebar panel (whatever name Home Assistant gave it). */
export function panelPrefix(): string {
  return `/${window.location.pathname.split("/").filter(Boolean)[0] ?? "lovelace"}`;
}

/** The address of a page of the panel, e.g. `/kestrel/visit?v=12`. */
export function routePath(view: string, search = ""): string {
  return `${panelPrefix()}/${view}${search}`;
}
