import type { HassConnection, HomeAssistant as LuHomeAssistant } from "lucent-ha";

export type CameraHealth = "ok" | "unstable" | "offline";
export type VisitKind = "seen" | "heard";
export type VisitStatus = "auto" | "learned" | "corrected" | "confirmed" | "not_animal" | "unknown";
export type Group = "bird" | "mammal" | "other" | "unknown";
export type ClipState = "pending" | "ready" | "none" | "deleted";

/** A camera's most recent visit. `kind` and `grp` are optional until the plugin sends them. */
export interface CameraDetection {
  species: string;
  at: string | number;
  visitId: string;
  kind?: VisitKind;
  grp?: Group;
}

export interface Camera {
  id: string | number;
  name: string;
  nvrCardId: string | number | null;
  online: boolean;
  health: CameraHealth;
  drops1h: number;
  wildlife: boolean;
  /** The link to a current picture of the camera (signed by the integration), refreshed by the panel while it is shown. */
  picture?: string | null;
  lastDetection: CameraDetection | null;
}

export interface VisitSuggestion {
  species: string;
  why: "model" | "heard" | "usual";
}

/** One species the second listen (Perch, in the audio service) hears more strongly than the one the microphone's detector named. */
export interface AudioAlternative {
  species: string;
  scientific?: string | null;
  /** 0 to 1: how likely it is, if the sound can only be one of the species that live here. */
  score: number;
  /** Persistence: how many half-second steps in a row held at least 90% of the best score. */
  windowsHigh?: number | null;
  /** Where in the original clip it is strongest (the best five seconds), in seconds. */
  window?: { start: number; end: number } | null;
}

/** The bird-call preview service's report on one recording. `segment` is the matched moment, in seconds
 * from the start of the original clip. */
export interface AudioInfo {
  state: "pending" | "ready" | "failed";
  segment?: { start: number; end: number } | null;
  cleaned?: boolean;
  method?: string;
  /** How sure Perch is of the detector's species on the matched moment, as it was heard and as it was shipped. */
  scores?: { original: number | null; preview: number | null } | null;
  /** "Could also be": species Perch hears more strongly than the detector's, strongest first. `[]` = nothing stronger; absent = not looked at. */
  alternatives?: AudioAlternative[];
  /** Perch's own view of the species the detector named; `rank` 1 = the one it hears most strongly. */
  announced?: (AudioAlternative & { rank?: number | null }) | null;
}

/** How sure a heard visit is: a confident call, one kept quietly, one a person should look at. */
export type Tier = "likely" | "possible" | "check";
export type TierWhy = "strong" | "repeated" | "models_disagree" | "second_opinion_only" | "weak" | "rare_here" | "new_here";
/** One listening model's answer for a recording. `named` named the visit's species, `agree` said the same, `other` named a different species. */
export interface ModelCall {
  model: string;
  label: string;
  species: string;
  score: number | null;
  role: "named" | "agree" | "other";
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
  heard?: { visitId: string; species: string; hasAudio: boolean; audio_url?: string | null; audio?: string | null; audioOriginal?: string | null; audioInfo?: AudioInfo | null } | null;
  suggestions: VisitSuggestion[];
  firstEver: boolean;
  muted: boolean;
  audio?: string | null;
  /** The untouched recording, when `audio` is a cleaned preview of it. */
  audioOriginal?: string | null;
  /** How `audio` was prepared. While `state` is pending, `audio` is still the original. */
  audioInfo?: AudioInfo | null;
  /** Heard visits recorded after the upgrade: how sure the call is. Never on a camera ("seen") visit. */
  tier?: Tier;
  /** Why that tier, most important reason first. */
  tierWhy?: TierWhy[];
  /** 0..1: how likely this species is here this week (BirdNET-Go). Informational. */
  occurrence?: number | null;
  /** Other calls of the same species on the same microphone within 5 minutes. */
  repeats?: number;
  /** What each listening model said. */
  models?: ModelCall[];
  /** Seen visits: the wildlife classifier's confidence (0..1) in the label, for the saved crop. Null or absent = unknown. */
  labelScore?: number | null;
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
  /** Per-kind evidence, 30-day counts and latest times. Optional until the plugin sends them. */
  seenCount30d?: number;
  heardCount30d?: number;
  lastSeenAt?: string | number | null;
  lastHeardAt?: string | number | null;
  lastSeenCamera?: string | number | null;
  lastHeardCamera?: string | number | null;
  photo?: string | null;
  image?: string | null;
  photo_url?: string | null;
  referenceImage?: string | null;
  referenceImageInfoUrl?: string | null;
}

/** Who took a species' reference photo and under which licence (`referenceImageInfoUrl`). Any part may be "", `page` is an https link or "". */
export interface PhotoCredit { source: string; credit: string; licence: string; page: string }

export interface Health {
  detector: { name: string; provider: string; avgMs: number | null; checksToday: number };
  gpu: { usedMiB: number; totalMiB: number; util: number };
  cameras: Array<{ id: string | number; checksToday: number; emptyChecksToday: number; visitsToday: number }>;
  storage: { dbMB: number; mediaMB: number; budgetMB: number };
  birdnet: { online: boolean; lastHeardAt: string | number | null } | null;
  birdnetLink?: string | null;
  corrections: { total: number; sinceRetrain: number };
}

export interface Settings {
  mutedSpecies: string[];
  heardNotify: "new_only" | "never";
}

/** BirdNET-Go's local species filter: how strict it is, and how many species that lets through where the microphone is. */
export interface RangeFilter {
  /** 0.01 is 1%: a species must be at least that likely at this place and time of year. */
  threshold: number;
  speciesCount: number;
  latitude: number | null;
  longitude: number | null;
  /** When BirdNET-Go last rebuilt its species list; it changes once a new threshold has taken effect. */
  updatedAt: string | null;
  /** BirdNET-Go is still rebuilding its species list; `speciesCount` may be the old one. */
  rebuilding: boolean;
  /** Only a Home Assistant administrator can change it. */
  canChange: boolean;
}

export interface VisitPage { items: Visit[]; next?: string | null; }
export interface SpeciesDetail {
  species?: Species;
  visits?: Visit[];
  recentVisits?: Visit[];
  calls?: Visit[];
  [key: string]: unknown;
}

/** One reference recording of a species: a clip from a public sound library (never one of the user's own recordings), played through a signed Home Assistant link. */
export interface ReferenceClip {
  /** Opaque: `xc-694038` or `inat-1944677`. */
  id: string;
  kind: "song" | "call" | "other";
  /** What to call it: "Song", "Call", "Recording" (a lone iNaturalist clip), "Clip 1", "Clip 2", "Clip 3" (several). Shown as it comes. */
  label: string;
  source: "xeno-canto" | "inaturalist";
  /** The source's name for people: "Xeno-canto" or "iNaturalist". */
  sourceName: string;
  /** The recordist or observer; "" when unknown. */
  credit: string;
  /** "CC BY-NC-SA 4.0", "All rights reserved"...; "" when unknown. */
  licence: string;
  /** "A" to "E" (Xeno-canto only). */
  quality: string | null;
  seconds: number | null;
  /** The page about this recording at its source. */
  page: string;
  /** The signed Home Assistant media link; valid for 12 hours, like every media link. */
  url: string;
}

/** What the server says about the reference recordings of one species. `ready` carries 1 to 3 clips; `none` is a stable "no reference recording exists";
 * `unavailable` is "could not look it up right now, try again". */
export interface ReferenceSounds {
  species: string;
  scientific: string | null;
  state: "ready" | "none" | "unavailable";
  clips: ReferenceClip[];
}
/** What Home Assistant hands the panel: the toolkit's slice of it, with the calls Kestrel makes typed more strictly. */
export interface HomeAssistant extends LuHomeAssistant {
  callWS<T = unknown>(message: Record<string, unknown>): Promise<T>;
  connection: HassConnection & {
    /** `resubscribe: false`: after a reconnect the panel subscribes again itself (and can retry), instead of the library doing it once. */
    subscribeMessage<T>(callback: (message: T) => void, message: Record<string, unknown>, options?: { resubscribe?: boolean }): Promise<() => Promise<void>>;
  };
  user?: NonNullable<LuHomeAssistant["user"]> & { id?: string };
}
export interface KestrelCardConfig { type?: string; view?: "live" | "visit" | "wildlife" | "insights"; }
export interface KestrelPush {
  type?: "event";
  event?: { type: "visit_new" | "visit_updated" | "visit_deleted" | "camera"; data: unknown };
}
export interface VisitQuery {
  camera?: string;
  species?: string;
  kind?: VisitKind;
  status?: VisitStatus;
  before?: string;
  limit?: number;
}
