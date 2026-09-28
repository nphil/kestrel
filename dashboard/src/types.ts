export type CameraHealth = "ok" | "unstable" | "offline";
export type VisitKind = "seen" | "heard";
export type VisitStatus = "auto" | "learned" | "corrected" | "confirmed" | "not_animal" | "unknown";
export type Group = "bird" | "mammal" | "unknown";
export type ClipState = "pending" | "ready" | "none" | "deleted";

export interface Camera {
  id: string | number;
  name: string;
  nvrCardId: string | number | null;
  online: boolean;
  health: CameraHealth;
  drops1h: number;
  wildlife: boolean;
  lastDetection: Record<string, unknown> | null;
}

export interface VisitSuggestion {
  species: string;
  why: "model" | "heard" | "usual";
}

export interface Visit {
  id: string;
  camera: { id: string | number; name: string };
  kind: VisitKind;
  startedAt: string | number;
  species: string;
  grp: Group;
  status: VisitStatus;
  score: number;
  snapshot?: string | null;
  crop?: string | null;
  clip: { state: ClipState; expectedReadyAt?: string | number | null; url?: string | null; media?: string | null };
  heard?: { visitId: string; species: string; hasAudio: boolean; audio_url?: string | null; audio?: string | null } | null;
  suggestions: VisitSuggestion[];
  firstEver: boolean;
  muted: boolean;
  audio?: string | null;
}

export interface Species {
  species: string;
  grp: Group;
  seen: boolean;
  heard: boolean;
  first: string | null;
  last: string | null;
  count30d: number;
  hasPhoto: boolean;
  cameras: Record<string, number>;
  hours: number[];
  newThisYear: boolean;
  photo?: string | null;
  image?: string | null;
  photo_url?: string | null;
}

export interface Health {
  detector: { name: string; provider: string; avgMs: number; checksToday: number };
  gpu: { usedMiB: number; totalMiB: number; util: number };
  cameras: Array<{ id: string | number; checksToday: number; emptyChecksToday: number; visitsToday: number }>;
  storage: { dbMB: number; mediaMB: number; budgetMB: number };
  birdnet: { online: boolean; lastHeardAt: string | number | null } | null;
  corrections: { total: number; sinceRetrain: number };
}

export interface Settings {
  mutedSpecies: string[];
  heardNotify: "new_only" | "never";
}

export interface VisitPage { items: Visit[]; next?: string | null; }
export interface SpeciesDetail {
  species?: Species;
  visits?: Visit[];
  recentVisits?: Visit[];
  calls?: Visit[];
  [key: string]: unknown;
}
export interface HomeAssistant {
  callWS<T = unknown>(message: Record<string, unknown>): Promise<T>;
  connection: {
    subscribeMessage<T>(callback: (message: T) => void, message: Record<string, unknown>): Promise<() => Promise<void>>;
  };
}
export interface KestrelCardConfig { type?: string; view?: "live" | "visit" | "wildlife" | "insights"; }
export interface KestrelPush {
  type?: "event";
  event?: { type: "visit_new" | "visit_updated" | "camera"; data: unknown };
}
export interface VisitQuery {
  camera?: string;
  species?: string;
  kind?: VisitKind;
  status?: VisitStatus;
  before?: string;
  limit?: number;
}
