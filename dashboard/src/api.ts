import type { Camera, Health, HomeAssistant, KestrelCardConfig, Settings, Species, SpeciesDetail, Visit, VisitPage, VisitQuery } from "./types.ts";

export function callWS<T>(hass: HomeAssistant, type: string, fields: Record<string, unknown> = {}): Promise<T> {
  return hass.callWS<T>({ type, ...fields });
}

export const api = {
  cameras: (hass: HomeAssistant) => callWS<Camera[] | { items: Camera[] }>(hass, "kestrel/cameras"),
  visits: (hass: HomeAssistant, query: VisitQuery = {}) => callWS<VisitPage>(hass, "kestrel/visits", query as Record<string, unknown>),
  visit: (hass: HomeAssistant, visitId: string) => callWS<Visit>(hass, "kestrel/visit", { visit_id: visitId }),
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

export function asArray<T>(value: unknown, key = "items"): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === "object") {
    const candidate = (value as Record<string, unknown>)[key];
    if (Array.isArray(candidate)) return candidate as T[];
  }
  return [];
}

export function asVisit(value: unknown): Visit | null {
  if (!value || typeof value !== "object") return null;
  const outer = value as Record<string, unknown>;
  const candidate = outer.visit && typeof outer.visit === "object" ? outer.visit : outer;
  return candidate as Visit;
}

export function visitPage(value: unknown): VisitPage {
  if (Array.isArray(value)) return { items: value as Visit[] };
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return { items: Array.isArray(record.items) ? record.items as Visit[] : [], next: typeof record.next === "string" ? record.next : null };
  }
  return { items: [] };
}

export function speciesArray(value: unknown): Species[] {
  if (Array.isArray(value)) return value as Species[];
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.items)) return record.items as Species[];
  if (Array.isArray(record.species)) return record.species as Species[];
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

export function speciesFromDetail(value: SpeciesDetail | Species, fallback: Species): Species {
  if (!value || typeof value !== "object") return fallback;
  const candidate = "species" in value && typeof value.species === "object" ? value.species : value;
  return candidate as Species;
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

export function speciesPhoto(species: Species, detail?: unknown): string | null {
  const item = detail && typeof detail === "object" ? detail as Record<string, unknown> : {};
  const direct = item.photo_url ?? item.photo ?? item.image ?? item.photoUrl ?? item.imageUrl;
  return mediaUrl(typeof direct === "string" ? direct : species.photo_url ?? species.photo ?? species.image ?? null);
}

export function speciesReferencePhoto(detail: unknown, species?: Species): string | null {
  const item = detail && typeof detail === "object" ? detail as Record<string, unknown> : {};
  const nested = item.species && typeof item.species === "object" ? item.species as Record<string, unknown> : item;
  const direct = nested.referenceImage;
  return mediaUrl(typeof direct === "string" ? direct : species?.referenceImage ?? null);
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

export function navigate(path: string, search = ""): void {
  const dashboardPath = window.location.pathname.split("/").filter(Boolean)[0] ?? "lovelace";
  window.history.pushState({}, "", `/${dashboardPath}/${path}${search}`);
  window.dispatchEvent(new Event("location-changed"));
}
