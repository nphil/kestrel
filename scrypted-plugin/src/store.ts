import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import type { StatementSync } from 'node:sqlite';
import type { TrackBox, TrackSample, VisitTrack } from './track';

export type VisitKind = 'seen' | 'heard';
export type VisitGroup = 'bird' | 'mammal' | 'other' | 'unknown';
export type VisitStatus = 'auto' | 'learned' | 'corrected' | 'confirmed' | 'not_animal' | 'unknown';
export type ClipState = 'pending' | 'ready' | 'none' | 'deleted';
// Where a ready clip came from: the Events Recorder plugin's own clip, or a clip Kestrel cut from the NVR's continuous recording.
export type ClipSource = 'events' | 'nvr';

// How sure Kestrel is about a heard call (heard.ts): Likely may be announced and counts toward the species list,
// Possible is kept quietly (stored and listed, not counted), Check goes to the review queue.
export type Tier = 'likely' | 'possible' | 'check';
// `models_agree`: both BirdNET-Go models named this species. `birdnet_unlikely`: BirdNET-Go itself tagged the call as probably not a real call.
export type TierWhy = 'strong' | 'repeated' | 'models_agree' | 'models_disagree' | 'second_opinion_only' | 'weak' | 'rare_here' | 'new_here' | 'birdnet_unlikely';
// What one model said about a heard visit: `named` named the visit's species, `agree` said the same species,
// `other` named a different one (the models disagree).
export interface ModelCall { model: string; label: string; species: string; score: number | null; role: 'named' | 'agree' | 'other' }

export interface Visit {
    id: string;
    camera: { id: string; name: string };
    kind: VisitKind;
    startedAt: number;
    species: string;
    grp: VisitGroup;
    status: VisitStatus;
    score: number | null;
    snapshot: string | null;
    crop: string | null;
    // `source` is present on a ready clip (older rows have no source recorded and are all Events Recorder clips); `deletedBy: 'user'` marks a
    // clip a person deleted through clips/delete, as opposed to one that went missing or was pruned.
    clip: { state: ClipState; expectedReadyAt: number | null; url?: string; source?: ClipSource; deletedBy?: 'user' };
    heard: { visitId: string; species: string; hasAudio: boolean; birdnetDetectionId: number | null; birdnetClip: string | null } | null;
    audio: { birdnetDetectionId: number | null; birdnetClip: string | null } | null;
    suggestions: { species: string; why: 'model' | 'heard' | 'usual' }[];
    firstEver: boolean;
    muted: boolean;
    notify: boolean;
    review?: boolean;
    // Heard visits recorded since the confidence layer (heard.ts); absent on older ones and on seen visits.
    tier?: Tier;
    tierWhy?: TierWhy[];
    // BirdNET-Go's chance of this species here this week (0-1); null when the message did not carry it.
    occurrence?: number | null;
    // How common local sightings say this species is at this time of year (0-1); null when unknown (see seasonal.ts).
    commonness?: number | null;
    // Other calls of the same species on the same microphone within five minutes of the first one.
    repeats?: number;
    // BirdNET-Go's own verdict that no hit of this call looked like a real call of the species (its MQTT `unlikely` flag, kept the way BirdNET-Go
    // merges it: true only while every call folded into the visit was tagged). Such a visit is never Likely (heard.ts).
    unlikely?: boolean;
    models?: ModelCall[];
    // Seen visits: the wildlife classifier's confidence in the label (0-1); null/absent when unknown.
    labelScore?: number | null;
}

export interface VisitMeta {
    detectionLabel?: string | null;
    snapshotFile?: string | null;
    cropFile?: string | null;
    clipFile?: string | null;
    clipSource?: ClipSource | null;
    // Wall-clock ms of the first frame of a ready clip (the detection boxes are drawn from it); null when that is not known: a clip from
    // before it was recorded, or one whose start could not be told.
    clipStartAt?: number | null;
    // Where the detection boxes really lie in the clip's video, measured from the footage (align.ts): the ms to add to a detection's time to get
    // its time in the video, and when that was tried. Both are null until the clip has been looked at; the offset stays null when nothing clear
    // was found (the default for the clip's source is used then).
    clipOffsetMs?: number | null;
    clipAlignedAt?: number | null;
    // Whether the clip file is Kestrel's own copy (in the clip store) rather than another plugin's file, and its size.
    clipKept?: boolean;
    clipBytes?: number | null;
    clipDeletedBy?: 'user' | null;
    audioFile?: string | null;
    birdnetDetectionId?: number | null;
    birdnetClip?: string | null;
    review?: boolean;
    lastChangeAt?: number | null;
    undoData?: string | null;
    lastCorrectionId?: number | null;
}

export interface SeenMergeUpdate {
    species: string;
    speciesChanged: boolean;
    grp: VisitGroup;
    status: VisitStatus;
    score: number | null;
    labelScore: number | null;
    startedAt: number;
    // Suggestions after the merge as planned (seen.ts planSeenMerge); 'usual' entries are only
    // kept as-is when the species did not change.
    suggestions: Visit['suggestions'];
    // Fresh "usual" suggestions for the new species; used only when the species changed.
    usual: Visit['suggestions'];
    // New raw model label when the incoming detection won, otherwise null (keep the stored one).
    detectionLabel: string | null;
    // Whether the (new) species is muted; used only when the species changed.
    muted: boolean;
}

export interface VisitFilters {
    camera?: string;
    species?: string;
    kind?: string;
    status?: string;
    before?: number;
    limit?: number;
}

export interface EventItem {
    seq: number;
    type: 'visit_new' | 'visit_updated' | 'visit_deleted' | 'camera';
    data: unknown;
}
export interface EventsResponse {
    seq: number;
    events?: EventItem[];
    resync?: true;
}
export interface PurgeResult {
    executed: boolean;
    before: number;
    removed: number;
    // BirdNET-Go detection ids of the removed (or, in a dry run, matching) visits.
    detectionIds: number[];
    species: number;
    // Kept seen visits whose link to a purged call was cleared.
    relinked: string[];
    remainingHeard: number;
}

// One BirdNET-Go detection as Kestrel kept it (table heard_calls). `visitId` stays null while the call waits for the
// other model's opinion, and for a call that made no visit of its own.
export interface HeardCallInput {
    cameraId: string;
    at: number;
    receivedAt: number;
    species: string;
    scientific: string | null;
    grp: VisitGroup;
    score: number | null;
    occurrence: number | null;
    model: string;
    modelRank: number;
    modelLabel: string;
    detectionId: number | null;
    clip: string | null;
    // BirdNET-Go's `unlikely` tag on this detection (see Visit.unlikely).
    unlikely: boolean;
}
export interface HeardCallRow extends HeardCallInput { id: number; visitId: string | null }


interface RawVisit {
    id: string;
    camera_id: string;
    camera_name: string;
    kind: VisitKind;
    started_at: number;
    species: string;
    grp: VisitGroup;
    status: VisitStatus;
    score: number | null;
    detection_label: string | null;
    snapshot_file: string | null;
    crop_file: string | null;
    clip_file: string | null;
    clip_source: ClipSource | null;
    clip_start_at: number | null;
    clip_offset_ms: number | null;
    clip_aligned_at: number | null;
    clip_kept: number;
    clip_bytes: number | null;
    clip_deleted_by: 'user' | null;
    audio_file: string | null;
    birdnet_detection_id: number | null;
    birdnet_clip: string | null;
    clip_state: ClipState;
    clip_expected_ready_at: number | null;
    review_flag: number;
    first_ever: number;
    muted: number;
    data: string;
    last_change_at: number | null;
    undo_data: string | null;
    last_correction_id: number | null;
    tier: Tier | null;
    updated_at: number;
}

interface RawHeardCall {
    id: number;
    camera_id: string;
    at: number;
    received_at: number;
    species: string;
    scientific: string | null;
    grp: VisitGroup;
    score: number | null;
    occurrence: number | null;
    model: string;
    model_rank: number;
    model_label: string;
    detection_id: number | null;
    clip: string | null;
    unlikely: number | null;
    visit_id: string | null;
}

const MAX_EVENTS = 500;
const MAX_EMBEDDINGS = 5_000;
const MAX_CORRECTION_CROPS = 5_000;
const VISIT_RETENTION_MS = 3 * 365 * 24 * 60 * 60 * 1000;
// Heard calls (the raw BirdNET-Go detections behind a heard visit) are only needed to pair the two models and to
// count repeats within minutes; a month is plenty for looking back at what the models said.
const HEARD_CALL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
// What one visit keeps of the boxes the detector drew (track.ts): at most this many events, none later than this long after its first
// one (no clip is longer than about 70 s).
export const TRACK_MAX_FRAMES = 480;
export const TRACK_MAX_SPAN_MS = 90_000;
// A clip is only looked at to find where its boxes lie (align.ts) when its visit kept at least this many detection events.
export const ALIGN_MIN_SAMPLES = 6;

// A visit counts toward the species list, "first ever", the camera's latest sighting and the like unless it is a heard
// call that is only Possible or Check and nobody has confirmed or corrected it. A NULL tier (camera visits, older heard
// visits) counts. `counts` is the same rule for one row.
const COUNTS_SQL = "(tier IS NULL OR tier='likely' OR status IN ('confirmed','corrected'))";
function counts(row: { tier?: Tier | null; status: VisitStatus }): boolean {
    return !row.tier || row.tier === 'likely' || row.status === 'confirmed' || row.status === 'corrected';
}
const NEW_YORK_TIME_ZONE = 'America/New_York';
const NEW_YORK_FORMATTER = new Intl.DateTimeFormat('en-US', {
    timeZone: NEW_YORK_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

type NewYorkParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function newYorkParts(at: number): NewYorkParts {
    const parts = NEW_YORK_FORMATTER.formatToParts(new Date(at));
    let year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0;
    for (const part of parts) {
        const value = Number(part.value);
        if (part.type === 'year') year = value;
        else if (part.type === 'month') month = value;
        else if (part.type === 'day') day = value;
        else if (part.type === 'hour') hour = value;
        else if (part.type === 'minute') minute = value;
        else if (part.type === 'second') second = value;
    }
    return { year, month, day, hour, minute, second };
}

function newYorkDayKey(at: number): string {
    const { year, month, day } = newYorkParts(at);
    return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function newYorkMidnight(year: number, month: number, day: number): number {
    const target = Date.UTC(year, month - 1, day);
    let candidate = target;
    for (let i = 0; i < 3; i++) {
        const local = newYorkParts(candidate);
        const localAsUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
        const offset = localAsUtc - Math.floor(candidate / 1000) * 1000;
        const adjusted = target - offset;
        if (adjusted === candidate) break;
        candidate = adjusted;
    }
    return candidate;
}

function newYorkDayBounds(at: number): { day: string; start: number; end: number } {
    const parts = newYorkParts(at);
    const nextDay = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
    const day = `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
    return {
        day,
        start: newYorkMidnight(parts.year, parts.month, parts.day),
        end: newYorkMidnight(nextDay.getUTCFullYear(), nextDay.getUTCMonth() + 1, nextDay.getUTCDate()),
    };
}

// ---- Periods, seasons and per-day counts for the species figures. Like the day counters above, all of it is New York time. ----

export type SpeciesPeriod = 'today' | 'week' | 'month' | 'all';
// Which visits a highlight looks at: only those seen on a camera, only those heard, or both.
export type HighlightKind = 'seen' | 'heard' | 'both';
export type Season = 'winter' | 'spring' | 'summer' | 'autumn';

const DAY_MS = 24 * 60 * 60 * 1000;
// How many whole New York days a period reaches back, today included.
const PERIOD_DAYS = { today: 1, week: 7, month: 30 } as const;
// A species is "new" (to the home, or to the season) for this long after its first visit.
const NEW_WINDOW_MS = 7 * DAY_MS;
// A species seen this recently before a season began was already around when it began, so the season did not bring it.
const SEASON_CARRYOVER_MS = 30 * DAY_MS;
// The species sheet charts this many days of counts.
const PER_DAY_COUNT = 30;
// The visits the species list counts: named animals, minus the heard calls that do not count yet (COUNTS_SQL).
const SPECIES_ROWS_SQL = `status NOT IN ('not_animal','unknown') AND species NOT IN ('Unidentified animal','unknown') AND ${COUNTS_SQL}`;

interface SpeciesRow { species: string; grp: VisitGroup; kind: VisitKind; started_at: number; camera_id: string }
interface HighlightRow { id: string; species: string; grp: VisitGroup; kind: VisitKind; started_at: number }

// What the species list says about one species (see KestrelStore.speciesList).
interface SpeciesEntry {
    species: string; grp: VisitGroup; seen: boolean; heard: boolean; first: number; last: number;
    count30d: number; hasPhoto: boolean; cameras: Record<string, number>; hours: number[]; newThisYear: boolean;
    seenCount30d: number; heardCount30d: number;
    lastSeenAt: number | null; lastHeardAt: number | null; lastSeenCamera: string | null; lastHeardCamera: string | null;
    periodCount: number; periodSeen: number; periodHeard: number;
}

// Adds counted visits (oldest first) up into one entry per species; `photos` names the species that have a best picture.
function tallySpecies(rows: SpeciesRow[], period: SpeciesPeriod, now: number, photos: ReadonlySet<string>): SpeciesEntry[] {
    const since = periodStart(period, now);
    const yearStart = new Date(new Date(now).getFullYear(), 0, 1).getTime();
    const species = new Map<string, SpeciesEntry>();
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
    for (const row of rows) {
        let item = species.get(row.species);
        if (!item) {
            item = { species: row.species, grp: row.grp, seen: false, heard: false, first: row.started_at, last: row.started_at,
                count30d: 0, hasPhoto: photos.has(row.species), cameras: {}, hours: Array(24).fill(0) as number[], newThisYear: row.started_at >= yearStart,
                seenCount30d: 0, heardCount30d: 0, lastSeenAt: null, lastHeardAt: null, lastSeenCamera: null, lastHeardCamera: null,
                periodCount: 0, periodSeen: 0, periodHeard: 0 };
            species.set(row.species, item);
        }
        item.seen ||= row.kind === 'seen';
        item.heard ||= row.kind === 'heard';
        item.first = Math.min(item.first, row.started_at);
        item.last = Math.max(item.last, row.started_at);
        if (since === null || row.started_at >= since) {
            item.periodCount++;
            if (row.kind === 'seen') item.periodSeen++; else item.periodHeard++;
        }
        const recent = row.started_at >= thirtyDaysAgo;
        if (recent) item.count30d++;
        if (row.kind === 'seen') {
            if (recent) item.seenCount30d++;
            if (item.lastSeenAt === null || row.started_at >= item.lastSeenAt) { item.lastSeenAt = row.started_at; item.lastSeenCamera = row.camera_id; }
        } else {
            if (recent) item.heardCount30d++;
            if (item.lastHeardAt === null || row.started_at >= item.lastHeardAt) { item.lastHeardAt = row.started_at; item.lastHeardCamera = row.camera_id; }
        }
        item.cameras[row.camera_id] = (item.cameras[row.camera_id] ?? 0) + 1;
        item.hours[new Date(row.started_at).getHours()]++;
    }
    return [...species.values()];
}

// What one of a period's highlights says: a species, how often it came in the period (`count`) and ever (`total`), and the visit that
// stands for it (`at`, `visitId`, `kind`: the species' newest visit in the period).
export interface Highlight {
    species: string; grp: VisitGroup; kind: VisitKind; count: number; total: number; at: number; visitId: string; hasPhoto: boolean;
}
export interface Highlights { period: SpeciesPeriod; kind: HighlightKind; latest: Highlight | null; top: Highlight | null; rare: Highlight | null }

// What the species sheet shows beyond a species' list entry. The description comes from Wikipedia and is filled in by the Home
// Assistant integration, the only part of Kestrel that talks to the internet; the plugin leaves both description fields null.
export interface SpeciesInsights {
    perDay: number[]; perDayFrom: string;
    firstAt: number | null; lastAt: number | null;
    bestScore: number | null; bestVisitId: string | null;
    newThisSeason: boolean; newToHome: boolean; season: Season;
    description: null; descriptionSource: null;
}

export function parseSpeciesPeriod(value: string | null | undefined): SpeciesPeriod {
    if (value === null || value === undefined || value === '') return 'all';
    if (value === 'today' || value === 'week' || value === 'month' || value === 'all') return value;
    throw Object.assign(new Error('period must be today, week, month or all'), { status: 400 });
}

export function parseHighlightKind(value: string | null | undefined): HighlightKind {
    if (value === null || value === undefined || value === '') return 'both';
    if (value === 'seen' || value === 'heard' || value === 'both') return value;
    throw Object.assign(new Error('kind must be seen, heard or both'), { status: 400 });
}

// The first moment (ms) of a period, counted in whole New York days back from `now`; null for 'all', which has no start.
export function periodStart(period: SpeciesPeriod, now: number): number | null {
    if (period === 'all') return null;
    const { year, month, day } = newYorkParts(now);
    return newYorkMidnight(year, month, day - (PERIOD_DAYS[period] - 1));
}

// The meteorological season `at` falls in (December-February winter, March-May spring, June-August summer, September-November
// autumn) and the New York midnight it began.
export function seasonOf(at: number): { season: Season; start: number } {
    const { year, month } = newYorkParts(at);
    const season: Season = month === 12 || month <= 2 ? 'winter' : month <= 5 ? 'spring' : month <= 8 ? 'summer' : 'autumn';
    const startMonth = { winter: 12, spring: 3, summer: 6, autumn: 9 }[season];
    return { season, start: newYorkMidnight(season === 'winter' && month <= 2 ? year - 1 : year, startMonth, 1) };
}

// The `count` New York calendar days ending with the one `at` falls in, oldest first, as YYYY-MM-DD.
function recentDayKeys(at: number, count: number): string[] {
    const { year, month, day } = newYorkParts(at);
    return Array.from({ length: count }, (_, i) => new Date(Date.UTC(year, month - 1, day - (count - 1 - i))).toISOString().slice(0, 10));
}

export class KestrelStore {
    readonly db: DatabaseSync;
    private readonly dbPath: string;
    private readonly recordDetectorCheckStatement: StatementSync;
    private readonly recordBirdnetIgnoredStatement: StatementSync;

    // Told the ids of visit rows right after they are removed (one call per removal, never with an
    // empty list). main.ts turns it into `visit_deleted` events so open dashboards drop them. It
    // runs in the middle of the removing operation, so it must not throw.
    onVisitsDeleted?: (ids: string[]) => void;

    constructor(path: string) {
        this.dbPath = path;
        this.db = new DatabaseSync(path);
        this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA auto_vacuum=INCREMENTAL; PRAGMA synchronous=NORMAL;');
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS visits (
                id TEXT PRIMARY KEY,
                camera_id TEXT NOT NULL,
                camera_name TEXT NOT NULL,
                kind TEXT NOT NULL,
                started_at INTEGER NOT NULL,
                species TEXT NOT NULL,
                grp TEXT NOT NULL,
                status TEXT NOT NULL,
                score REAL,
                detection_label TEXT,
                snapshot_file TEXT,
                crop_file TEXT,
                clip_file TEXT,
                audio_file TEXT,
                clip_state TEXT NOT NULL DEFAULT 'pending',
                clip_expected_ready_at INTEGER,
                review_flag INTEGER NOT NULL DEFAULT 0,
                first_ever INTEGER NOT NULL DEFAULT 0,
                muted INTEGER NOT NULL DEFAULT 0,
                data TEXT NOT NULL,
                last_change_at INTEGER,
                undo_data TEXT,
                last_correction_id INTEGER,
                updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS visits_started_at ON visits(started_at DESC);
            CREATE INDEX IF NOT EXISTS visits_camera_species_started ON visits(camera_id, species, started_at DESC);
            CREATE INDEX IF NOT EXISTS visits_species_started ON visits(species, started_at DESC);
            CREATE INDEX IF NOT EXISTS visits_clip_state ON visits(clip_state, started_at);
            CREATE INDEX IF NOT EXISTS visits_review ON visits(review_flag, started_at DESC);
            CREATE TABLE IF NOT EXISTS camera_daily_stats (
                day TEXT NOT NULL,
                camera_id TEXT NOT NULL,
                checks INTEGER NOT NULL DEFAULT 0,
                empty_checks INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY(day, camera_id)
            );
            CREATE TABLE IF NOT EXISTS birdnet_daily_stats (
                day TEXT PRIMARY KEY,
                ignored INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS species_best (
                species TEXT PRIMARY KEY,
                grp TEXT NOT NULL,
                visit_id TEXT NOT NULL,
                camera_id TEXT NOT NULL,
                snapshot_file TEXT,
                crop_file TEXT,
                score REAL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS corrections (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                visit_id TEXT NOT NULL,
                camera_id TEXT NOT NULL,
                at INTEGER NOT NULL,
                from_label TEXT NOT NULL,
                to_label TEXT NOT NULL,
                score REAL,
                confirmed INTEGER NOT NULL DEFAULT 0,
                snapshot_file TEXT,
                crop_file TEXT
            );
            CREATE INDEX IF NOT EXISTS corrections_at ON corrections(at DESC);
            CREATE INDEX IF NOT EXISTS corrections_mapping ON corrections(camera_id, from_label, to_label, at DESC);
            CREATE TABLE IF NOT EXISTS embeddings (
                correction_id INTEGER PRIMARY KEY,
                camera_id TEXT NOT NULL,
                from_label TEXT NOT NULL,
                to_label TEXT NOT NULL,
                embedding BLOB NOT NULL,
                created_at INTEGER NOT NULL,
                FOREIGN KEY(correction_id) REFERENCES corrections(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS embeddings_mapping ON embeddings(camera_id, from_label, to_label, created_at DESC);
            CREATE TABLE IF NOT EXISTS events (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                type TEXT NOT NULL,
                data TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS known_species (
                species TEXT PRIMARY KEY,
                first_at INTEGER NOT NULL,
                purged_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS heard_calls (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                camera_id TEXT NOT NULL,
                at INTEGER NOT NULL,
                received_at INTEGER NOT NULL,
                species TEXT NOT NULL,
                scientific TEXT,
                grp TEXT NOT NULL,
                score REAL,
                occurrence REAL,
                model TEXT NOT NULL,
                model_rank INTEGER NOT NULL,
                model_label TEXT NOT NULL,
                detection_id INTEGER,
                clip TEXT,
                visit_id TEXT
            );
            CREATE INDEX IF NOT EXISTS heard_calls_camera_at ON heard_calls(camera_id, at);
            CREATE INDEX IF NOT EXISTS heard_calls_at ON heard_calls(at);
            CREATE TABLE IF NOT EXISTS models_seen (
                model TEXT PRIMARY KEY,
                rank INTEGER NOT NULL,
                last_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS visit_boxes (
                visit_id TEXT NOT NULL,
                t INTEGER NOT NULL,
                boxes TEXT NOT NULL,
                PRIMARY KEY(visit_id, t),
                FOREIGN KEY(visit_id) REFERENCES visits(id) ON DELETE CASCADE
            ) WITHOUT ROWID;
        `);
        // One-time migration: the visits table predates these two columns (BirdNET-Go's
        // own detection reference), so a pre-existing on-disk DB needs them added explicitly --
        // CREATE TABLE IF NOT EXISTS above does not alter an existing table.
        const visitColumns = new Set((this.db.prepare('PRAGMA table_info(visits)').all() as { name: string }[]).map(column => column.name));
        if (!visitColumns.has('birdnet_detection_id')) this.db.exec('ALTER TABLE visits ADD COLUMN birdnet_detection_id INTEGER');
        if (!visitColumns.has('birdnet_clip')) this.db.exec('ALTER TABLE visits ADD COLUMN birdnet_clip TEXT');
        // One-time migration: heard visits now carry how sure Kestrel is about them (`tier`, see heard.ts). A NULL tier
        // means "not rated" -- every older visit and every camera visit -- and counts exactly as before.
        if (!visitColumns.has('tier')) this.db.exec('ALTER TABLE visits ADD COLUMN tier TEXT');
        this.db.exec('CREATE INDEX IF NOT EXISTS visits_tier ON visits(tier, started_at DESC)');
        // One-time migration: where a ready clip came from (NULL = recorded before this existed = Events Recorder), whether the file is
        // Kestrel's own copy in the clip store (`clip_kept`, with its size) and who deleted a deleted clip ('user' for clips/delete).
        if (!visitColumns.has('clip_source')) this.db.exec('ALTER TABLE visits ADD COLUMN clip_source TEXT');
        if (!visitColumns.has('clip_kept')) this.db.exec('ALTER TABLE visits ADD COLUMN clip_kept INTEGER NOT NULL DEFAULT 0');
        if (!visitColumns.has('clip_bytes')) this.db.exec('ALTER TABLE visits ADD COLUMN clip_bytes INTEGER');
        if (!visitColumns.has('clip_deleted_by')) this.db.exec('ALTER TABLE visits ADD COLUMN clip_deleted_by TEXT');
        // One-time migration: the wall-clock moment a ready clip's first frame was recorded (NULL = not known, as for every clip from before
        // this existed); the detection boxes of the visit (table visit_boxes) are drawn from it.
        if (!visitColumns.has('clip_start_at')) this.db.exec('ALTER TABLE visits ADD COLUMN clip_start_at INTEGER');
        // One-time migration: where the boxes really lie in a ready clip's video, measured from the footage (`clip_offset_ms`, NULL = not known),
        // and when that was tried (`clip_aligned_at`, NULL = not yet: the clip is looked at once, and again only if it is replaced).
        if (!visitColumns.has('clip_offset_ms')) this.db.exec('ALTER TABLE visits ADD COLUMN clip_offset_ms INTEGER');
        if (!visitColumns.has('clip_aligned_at')) this.db.exec('ALTER TABLE visits ADD COLUMN clip_aligned_at INTEGER');
        // One-time migration: BirdNET-Go's `unlikely` tag on each heard call (0 = not tagged, which is also what every older call was).
        const heardCallColumns = new Set((this.db.prepare('PRAGMA table_info(heard_calls)').all() as { name: string }[]).map(column => column.name));
        if (!heardCallColumns.has('unlikely')) this.db.exec('ALTER TABLE heard_calls ADD COLUMN unlikely INTEGER NOT NULL DEFAULT 0');
        this.recordDetectorCheckStatement = this.db.prepare(`INSERT INTO camera_daily_stats(day,camera_id,checks,empty_checks) VALUES(?,?,1,?)
            ON CONFLICT(day,camera_id) DO UPDATE SET checks=checks+1,empty_checks=empty_checks+excluded.empty_checks`);
        this.recordBirdnetIgnoredStatement = this.db.prepare(`INSERT INTO birdnet_daily_stats(day,ignored) VALUES(?,1)
            ON CONFLICT(day) DO UPDATE SET ignored=ignored+1`);
    }

    getSetting(key: string, fallback = ''): string {
        const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined;
        return row?.value ?? fallback;
    }

    setSetting(key: string, value: string): void {
        this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
    }

    getJsonSetting<T>(key: string, fallback: T): T {
        try {
            return JSON.parse(this.getSetting(key, JSON.stringify(fallback))) as T;
        } catch {
            return fallback;
        }
    }

    getRawVisit(id: string): RawVisit | undefined {
        return this.db.prepare('SELECT * FROM visits WHERE id=?').get(id) as RawVisit | undefined;
    }

    getVisit(id: string): Visit | undefined {
        const row = this.getRawVisit(id);
        return row ? this.decodeVisit(row) : undefined;
    }

    private decodeVisit(row: RawVisit): Visit {
        const visit = JSON.parse(row.data) as Visit;
        visit.camera = { id: row.camera_id, name: row.camera_name };
        visit.kind = row.kind;
        visit.startedAt = row.started_at;
        visit.species = row.species;
        visit.grp = row.grp;
        visit.status = row.status;
        visit.score = row.score;
        visit.snapshot = row.snapshot_file ? `media/snap/${row.id}.jpg` : null;
        visit.crop = row.crop_file ? `media/crop/${row.id}.jpg` : null;
        visit.clip = {
            state: row.clip_state,
            expectedReadyAt: row.clip_expected_ready_at,
            // A ready clip always says where it came from; a row from before the source was recorded is an Events Recorder clip.
            ...(row.clip_state === 'ready' ? { url: `media/clip/${row.id}.mp4`, source: row.clip_source ?? 'events' } : {}),
            ...(row.clip_state === 'deleted' && row.clip_deleted_by ? { deletedBy: row.clip_deleted_by } : {}),
        };
        visit.review = !!row.review_flag;
        visit.firstEver = !!row.first_ever;
        visit.muted = !!row.muted;
        if (row.tier) visit.tier = row.tier;
        else delete visit.tier;
        visit.notify = this.shouldNotify(visit);
        return visit;
    }

    saveVisit(visit: Visit, meta: VisitMeta = {}): void {
        const prior = this.getRawVisit(visit.id);
        const has = (key: keyof VisitMeta) => Object.prototype.hasOwnProperty.call(meta, key);
        const value = (key: keyof VisitMeta, old: unknown) => has(key) ? meta[key] ?? null : old ?? null;
        const snapshotFile = value('snapshotFile', prior?.snapshot_file) as string | null;
        const cropFile = value('cropFile', prior?.crop_file) as string | null;
        const clipFile = value('clipFile', prior?.clip_file) as string | null;
        const clipSource = value('clipSource', prior?.clip_source) as ClipSource | null;
        const clipStartAt = value('clipStartAt', prior?.clip_start_at) as number | null;
        const clipOffsetMs = value('clipOffsetMs', prior?.clip_offset_ms) as number | null;
        const clipAlignedAt = value('clipAlignedAt', prior?.clip_aligned_at) as number | null;
        const clipKept = has('clipKept') ? Number(!!meta.clipKept) : Number(prior?.clip_kept ?? 0);
        const clipBytes = value('clipBytes', prior?.clip_bytes) as number | null;
        const clipDeletedBy = value('clipDeletedBy', prior?.clip_deleted_by) as 'user' | null;
        const audioFile = value('audioFile', prior?.audio_file) as string | null;
        const birdnetDetectionId = value('birdnetDetectionId', prior?.birdnet_detection_id) as number | null;
        const birdnetClip = value('birdnetClip', prior?.birdnet_clip) as string | null;
        const review = has('review') ? !!meta.review : !!prior?.review_flag;
        const data = JSON.stringify(visit);
        const updatedAt = Date.now();
        this.db.prepare(`INSERT INTO visits (
            id,camera_id,camera_name,kind,started_at,species,grp,status,score,detection_label,
            snapshot_file,crop_file,clip_file,clip_source,clip_start_at,clip_offset_ms,clip_aligned_at,clip_kept,clip_bytes,clip_deleted_by,audio_file,birdnet_detection_id,birdnet_clip,clip_state,clip_expected_ready_at,
            review_flag,first_ever,muted,data,last_change_at,undo_data,last_correction_id,tier,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
            camera_id=excluded.camera_id,camera_name=excluded.camera_name,kind=excluded.kind,
            started_at=excluded.started_at,species=excluded.species,grp=excluded.grp,status=excluded.status,
            score=excluded.score,detection_label=excluded.detection_label,snapshot_file=excluded.snapshot_file,
            crop_file=excluded.crop_file,clip_file=excluded.clip_file,audio_file=excluded.audio_file,
            clip_source=excluded.clip_source,clip_start_at=excluded.clip_start_at,clip_offset_ms=excluded.clip_offset_ms,clip_aligned_at=excluded.clip_aligned_at,
            clip_kept=excluded.clip_kept,clip_bytes=excluded.clip_bytes,clip_deleted_by=excluded.clip_deleted_by,
            birdnet_detection_id=excluded.birdnet_detection_id,birdnet_clip=excluded.birdnet_clip,
            clip_state=excluded.clip_state,clip_expected_ready_at=excluded.clip_expected_ready_at,
            review_flag=excluded.review_flag,first_ever=excluded.first_ever,muted=excluded.muted,data=excluded.data,
            last_change_at=excluded.last_change_at,undo_data=excluded.undo_data,
            last_correction_id=excluded.last_correction_id,tier=excluded.tier,updated_at=excluded.updated_at`).run(
            visit.id, visit.camera.id, visit.camera.name, visit.kind, visit.startedAt, visit.species, visit.grp,
            visit.status, visit.score, has('detectionLabel') ? meta.detectionLabel ?? null : prior?.detection_label ?? null,
            snapshotFile, cropFile, clipFile, clipSource, clipStartAt, clipOffsetMs, clipAlignedAt, clipKept, clipBytes, clipDeletedBy, audioFile, birdnetDetectionId, birdnetClip, visit.clip.state, visit.clip.expectedReadyAt,
            Number(review), Number(visit.firstEver), Number(visit.muted), data,
            has('lastChangeAt') ? meta.lastChangeAt ?? null : prior?.last_change_at ?? null,
            has('undoData') ? meta.undoData ?? null : prior?.undo_data ?? null,
            has('lastCorrectionId') ? meta.lastCorrectionId ?? null : prior?.last_correction_id ?? null,
            visit.tier ?? null,
            updatedAt,
        );
    }

    private shouldNotify(visit: Visit): boolean {
        if (visit.muted)
            return false;
        if (visit.kind === 'seen')
            return true;
        // A call that is only Possible or Check is never announced; a person confirming or correcting it makes it count.
        return counts(visit) && this.getSetting('heardNotify', 'new_only') !== 'never' && visit.firstEver;
    }

    // The seen path's cooldown: was this species already SEEN on this camera since `since`? A bird
    // that was only heard does not count -- the seen visit is still recorded, then linked to the call.
    findRecentSeenVisit(cameraId: string, species: string, since: number): Visit | undefined {
        const row = this.db.prepare("SELECT * FROM visits WHERE camera_id=? AND species=? AND kind='seen' AND started_at>=? ORDER BY started_at DESC LIMIT 1").get(cameraId, species, since) as RawVisit | undefined;
        return row ? this.decodeVisit(row) : undefined;
    }

    findRecentHeardVisit(cameraId: string, species: string, since: number): Visit | undefined {
        const row = this.db.prepare("SELECT * FROM visits WHERE camera_id=? AND species=? AND kind='heard' AND started_at>=? ORDER BY started_at DESC LIMIT 1").get(cameraId, species, since) as RawVisit | undefined;
        return row ? this.decodeVisit(row) : undefined;
    }

    // The seen visit on this camera that started closest to `at`, within `windowMs` either side:
    // the visit a detection at `at` belongs to if it is the same animal at the same moment.
    findSeenNear(cameraId: string, at: number, windowMs: number): Visit | undefined {
        const row = this.db.prepare("SELECT * FROM visits WHERE camera_id=? AND kind='seen' AND started_at BETWEEN ? AND ? ORDER BY ABS(started_at-?) ASC, started_at ASC LIMIT 1")
            .get(cameraId, at - windowMs, at + windowMs, at) as RawVisit | undefined;
        return row ? this.decodeVisit(row) : undefined;
    }

    // One-time cleanup for a fixed bug: an overlapping pair of MQTT subscriptions caused every
    // BirdNET-Go detection to be ingested twice. The two deliveries are handled by two separate,
    // fully-synchronous calls to onBirdnetMessage, so when the message itself carries no
    // parseable Date+Time (startedAt falls back to `Date.now()`), the resulting timestamps differ
    // by whatever the event loop took to run the first delivery to completion -- observed in
    // practice as single-digit-to-low-tens of milliseconds, never seconds. Clusters consecutive
    // heard visits for the same camera+species whose gap to the previous one is within
    // DUPLICATE_WINDOW_MS (chained, so a run of 3+ near-simultaneous deliveries collapses too);
    // keeps the first (lowest rowid = earliest inserted) of each cluster, then recomputes
    // first_ever globally, since a duplicate could have taken the flag that belongs to the
    // surviving row (or vice versa).
    cleanupDuplicateHeardVisits(): { removed: number } {
        const DUPLICATE_WINDOW_MS = 2_000;
        const rows = this.db.prepare(
            "SELECT id, camera_id, species, started_at FROM visits WHERE kind='heard' ORDER BY camera_id, species, started_at ASC, rowid ASC"
        ).all() as { id: string; camera_id: string; species: string; started_at: number }[];
        const correctedIds = new Set((this.db.prepare('SELECT visit_id FROM corrections').all() as { visit_id: string }[]).map(r => r.visit_id));
        const toDelete: string[] = [];
        let clusterStart = 0;
        for (let i = 1; i <= rows.length; i++) {
            const prev = rows[i - 1];
            const cur = rows[i];
            const sameCluster = cur && cur.camera_id === prev.camera_id && cur.species === prev.species && cur.started_at - prev.started_at <= DUPLICATE_WINDOW_MS;
            if (sameCluster) continue;
            const cluster = rows.slice(clusterStart, i);
            for (const row of cluster.slice(1)) {
                if (!correctedIds.has(row.id)) toDelete.push(row.id);
            }
            clusterStart = i;
        }
        const removed = this.removeVisits(toDelete).length;
        this.recomputeFirstEver();
        return { removed };
    }

    private recomputeFirstEver(): void {
        this.db.exec('UPDATE visits SET first_ever=0');
        this.db.exec(`
            UPDATE visits SET first_ever=1 WHERE rowid IN (
                SELECT rowid FROM (
                    SELECT rowid, ROW_NUMBER() OVER (PARTITION BY species ORDER BY started_at ASC, rowid ASC) AS rn FROM visits
                    WHERE species NOT IN (SELECT species FROM known_species) AND ${COUNTS_SQL}
                ) WHERE rn=1
            )
        `);
    }

    // One-time migration: every heard visit was tagged grp='bird' regardless of species, because
    // the ingest path incorrectly assumed BirdNET-Go only ever detects birds -- Perch v2 is
    // multi-taxa (mammals, amphibians, insects too). Recomputes grp for stored heard visits using
    // `knownNonBird`, a small map of the specific non-bird common names known to exist in this
    // install's data (this migration only has the common name that was stored, not BirdNET-Go's
    // ScientificName the live ingest path now resolves precisely against the full taxonomy).
    // Species not in the map default to 'bird', same as the live path's own default. A 'drop'
    // resolution (Insecta -- too unreliable to keep) deletes the row unless a correction
    // references it.
    regroupHeardVisits(knownNonBird: Readonly<Record<string, VisitGroup | 'drop'>>): { regrouped: number; dropped: number } {
        const rows = this.db.prepare("SELECT id, species, grp FROM visits WHERE kind='heard'").all() as { id: string; species: string; grp: VisitGroup }[];
        const correctedIds = new Set((this.db.prepare('SELECT visit_id FROM corrections').all() as { visit_id: string }[]).map(r => r.visit_id));
        const updateGrp = this.db.prepare('UPDATE visits SET grp=? WHERE id=?');
        const dropIds: string[] = [];
        let regrouped = 0;
        for (const row of rows) {
            const resolved = knownNonBird[row.species.toLowerCase()];
            if (!resolved) continue;
            if (resolved === 'drop') {
                if (correctedIds.has(row.id)) continue;
                dropIds.push(row.id);
                continue;
            }
            if (resolved !== row.grp) {
                updateGrp.run(resolved, row.id);
                regrouped++;
            }
        }
        const dropped = this.removeVisits(dropIds).length;
        this.recomputeFirstEver();
        return { regrouped, dropped };
    }

    // Applies a same-moment merge (see seen.ts) to an existing seen visit: the species/score of
    // whichever detection won, the loser's label as a suggestion, and the bookkeeping that follows
    // a species change -- first_ever, muted, heard link, review flag, best-photo cache. Returns the
    // visit as stored. A replaced photo is the caller's job: it is rewritten in place, since the
    // photo files are named by the visit's id and the stored paths never change.
    applySeenMerge(visitId: string, update: SeenMergeUpdate): Visit | undefined {
        const raw = this.getRawVisit(visitId);
        if (!raw || raw.kind !== 'seen') return undefined;
        const visit = this.decodeVisit(raw);
        const shift = update.startedAt - visit.startedAt;
        if (shift !== 0) {
            visit.startedAt = update.startedAt;
            if (visit.clip.state === 'pending' && visit.clip.expectedReadyAt !== null) visit.clip.expectedReadyAt += shift;
        }
        visit.score = update.score;
        visit.labelScore = update.labelScore;
        visit.status = update.status;
        const meta: VisitMeta = {};
        if (update.detectionLabel !== null) meta.detectionLabel = update.detectionLabel;
        if (update.speciesChanged) {
            const previous = visit.species;
            visit.species = update.species;
            visit.grp = update.grp;
            visit.firstEver = !this.hasSpecies(update.species);
            visit.muted = update.muted;
            visit.heard = null;
            visit.review = false;
            meta.review = false;
            const models = update.suggestions.filter(item => item.why === 'model');
            visit.suggestions = [...models, ...update.usual.filter(item => item.species !== update.species && !models.some(model => model.species === item.species))];
            this.saveVisit(visit, meta);
            this.refreshSpeciesBestForVisit(visitId);
            this.recomputeFirstEverForSpecies(previous);
            this.recomputeFirstEverForSpecies(update.species);
        } else {
            visit.suggestions = update.suggestions;
            this.saveVisit(visit, meta);
        }
        const stored = this.getRawVisit(visitId);
        if (stored) this.considerSpeciesBest(this.decodeVisit(stored), stored.snapshot_file, stored.crop_file);
        return this.getVisit(visitId);
    }

    // Removes a visit row and demotes/replaces any best-photo entry that pointed at it.
    deleteVisitRow(visitId: string): void {
        this.removeVisits([visitId]);
        this.refreshSpeciesBestForVisit(visitId);
    }

    // The only place visit rows are deleted, so that every removal -- split-visit repair, duplicate
    // cleanup, regrouping, retention -- reaches onVisitsDeleted and a future delete cannot forget to.
    // Returns the ids that really were removed (an unknown id is skipped and not announced).
    private removeVisits(ids: readonly string[]): string[] {
        const deleteOne = this.db.prepare('DELETE FROM visits WHERE id=?');
        const removed = ids.filter(id => Number(deleteOne.run(id).changes) > 0);
        if (removed.length) this.onVisitsDeleted?.(removed);
        return removed;
    }

    // The earliest visit that counts holds the "first ever" flag for its species (none when the species is already known).
    recomputeFirstEverForSpecies(species: string): void {
        this.db.prepare('UPDATE visits SET first_ever=0 WHERE species=?').run(species);
        if (this.db.prepare('SELECT 1 FROM known_species WHERE species=?').get(species)) return;
        this.db.prepare(`UPDATE visits SET first_ever=1 WHERE rowid=(SELECT rowid FROM visits WHERE species=? AND ${COUNTS_SQL} ORDER BY started_at ASC, rowid ASC LIMIT 1)`).run(species);
    }

    // One-time repair for a raccoon that was filed twice (see seen.ts): folds `dropId` into
    // `keepId` -- the kept visit keeps its species, adopts the dropped visit's READY clip if it has
    // none, takes over the dropped visit's detection boxes, and offers the dropped visit's label as
    // a 'model' suggestion -- then deletes the dropped visit, its best-photo entry and its photo
    // files. Not a user correction, so no corrections row is written. 'absent' = one of the visits
    // does not exist (nothing to repair); 'skipped' = they are not a plain same-camera seen pair,
    // or a correction points at the dropped visit.
    async repairSplitSeenVisit(keepId: string, dropId: string): Promise<'merged' | 'absent' | 'skipped'> {
        const keepRaw = this.getRawVisit(keepId);
        const dropRaw = this.getRawVisit(dropId);
        if (!keepRaw || !dropRaw) return 'absent';
        if (keepRaw.kind !== 'seen' || dropRaw.kind !== 'seen' || keepRaw.camera_id !== dropRaw.camera_id) return 'skipped';
        if (this.db.prepare('SELECT 1 FROM corrections WHERE visit_id=? LIMIT 1').get(dropId)) return 'skipped';
        const keep = this.decodeVisit(keepRaw);
        const drop = this.decodeVisit(dropRaw);
        let clipFile = keepRaw.clip_file;
        let clipDetails: { clipSource?: ClipSource | null; clipStartAt?: number | null; clipOffsetMs?: number | null; clipAlignedAt?: number | null; clipKept?: boolean; clipBytes?: number | null } = {};
        if (keep.clip.state !== 'ready' && drop.clip.state === 'ready' && dropRaw.clip_file) {
            keep.clip.state = 'ready';
            clipFile = dropRaw.clip_file;
            clipDetails = { clipSource: dropRaw.clip_source, clipStartAt: dropRaw.clip_start_at, clipOffsetMs: dropRaw.clip_offset_ms, clipAlignedAt: dropRaw.clip_aligned_at, clipKept: !!dropRaw.clip_kept, clipBytes: dropRaw.clip_bytes };
        }
        if (drop.species !== keep.species && drop.species !== 'Unidentified animal')
            keep.suggestions = [{ species: drop.species, why: 'model' }, ...keep.suggestions.filter(item => item.species !== drop.species)];
        this.saveVisit(keep, { clipFile, ...clipDetails });
        // The boxes are wall-clock events, so they fit the kept visit whichever clip it ended up with; its own win where both have one.
        this.appendTrackFrames(keepId, this.getTrack(dropId).frames);
        const files = [dropRaw.snapshot_file, dropRaw.crop_file].filter((file): file is string => !!file);
        this.deleteVisitRow(dropId);
        this.recomputeFirstEverForSpecies(drop.species);
        this.recomputeFirstEverForSpecies(keep.species);
        await Promise.all(files.map(file => fs.rm(file, { force: true })));
        return 'merged';
    }

    // "Has this species ever been recorded?" -- the question behind every first-ever flag and alert. A heard call that is
    // only Possible or Check does not answer it (see COUNTS_SQL). Species whose visits were purged (purgeHeardBefore)
    // stay known, so a fresh start does not make every bird "new" again.
    hasSpecies(species: string): boolean {
        return !!this.db.prepare(`SELECT 1 FROM visits WHERE species=? AND status NOT IN ('not_animal','unknown') AND ${COUNTS_SQL} LIMIT 1`).get(species)
            || !!this.db.prepare('SELECT 1 FROM known_species WHERE species=?').get(species);
    }

    // --- Heard calls: every BirdNET-Go detection Kestrel received, as the models said it (heard.ts decides what it means) ---

    // Keeps one call. A message delivered twice (same microphone, species, model and second) is kept once; the repeat
    // returns undefined.
    recordHeardCall(call: HeardCallInput): number | undefined {
        if (this.db.prepare('SELECT 1 FROM heard_calls WHERE camera_id=? AND species=? AND model=? AND at=? LIMIT 1').get(call.cameraId, call.species, call.model, call.at))
            return undefined;
        const result = this.db.prepare(`INSERT INTO heard_calls(camera_id,at,received_at,species,scientific,grp,score,occurrence,model,model_rank,model_label,detection_id,clip,unlikely)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(call.cameraId, call.at, call.receivedAt, call.species, call.scientific, call.grp, call.score,
            call.occurrence, call.model, call.modelRank, call.modelLabel, call.detectionId, call.clip, call.unlikely ? 1 : 0);
        return Number(result.lastInsertRowid);
    }

    private decodeHeardCall(row: RawHeardCall): HeardCallRow {
        return {
            id: Number(row.id), cameraId: row.camera_id, at: row.at, receivedAt: row.received_at, species: row.species, scientific: row.scientific,
            grp: row.grp, score: row.score, occurrence: row.occurrence, model: row.model, modelRank: row.model_rank, modelLabel: row.model_label,
            detectionId: row.detection_id, clip: row.clip, unlikely: !!row.unlikely, visitId: row.visit_id,
        };
    }

    getHeardCall(id: number): HeardCallRow | undefined {
        const row = this.db.prepare('SELECT * FROM heard_calls WHERE id=?').get(id) as RawHeardCall | undefined;
        return row ? this.decodeHeardCall(row) : undefined;
    }

    // The calls on one microphone between two moments, oldest first.
    heardCallsNear(cameraId: string, from: number, to: number): HeardCallRow[] {
        return (this.db.prepare('SELECT * FROM heard_calls WHERE camera_id=? AND at BETWEEN ? AND ? ORDER BY at ASC, id ASC').all(cameraId, from, to) as unknown as RawHeardCall[])
            .map(row => this.decodeHeardCall(row));
    }

    attachHeardCall(id: number, visitId: string): void {
        this.db.prepare('UPDATE heard_calls SET visit_id=? WHERE id=?').run(visitId, id);
    }

    // Every BirdNET-Go message says which model made it, whether or not it became a call (an insect is dropped, an
    // unwatched microphone is ignored): remembering that is what tells which model is the main one.
    noteModelSeen(model: string, rank: number, at: number): void {
        this.db.prepare('INSERT INTO models_seen(model,rank,last_at) VALUES(?,?,?) ON CONFLICT(model) DO UPDATE SET rank=excluded.rank,last_at=MAX(last_at,excluded.last_at)').run(model, rank, at);
    }

    // The highest model rank that has spoken since `since` on any microphone: the model whose word counts as THE call.
    primaryModelRank(since: number): number {
        const row = this.db.prepare('SELECT MAX(rank) AS rank FROM models_seen WHERE last_at>=?').get(since) as { rank: number | null };
        return row.rank ?? 0;
    }

    // How many calls of this species were heard on this microphone in [from, to), not counting `exceptId`.
    countHeardCalls(cameraId: string, species: string, from: number, to: number, exceptId: number): number {
        const row = this.db.prepare('SELECT COUNT(*) AS n FROM heard_calls WHERE camera_id=? AND species=? AND at>=? AND at<? AND id<>?').get(cameraId, species, from, to, exceptId) as { n: number };
        return Number(row.n);
    }

    // Heard visits on this camera that started within `windowMs` of `at`, nearest first.
    findHeardVisitsNear(cameraId: string, at: number, windowMs: number): Visit[] {
        return (this.db.prepare("SELECT * FROM visits WHERE camera_id=? AND kind='heard' AND started_at BETWEEN ? AND ? ORDER BY ABS(started_at-?) ASC, started_at ASC LIMIT 10")
            .all(cameraId, at - windowMs, at + windowMs, at) as unknown as RawVisit[]).map(row => this.decodeVisit(row));
    }

    // The camera's latest visit that counts (a Possible or Check heard call is not "the latest animal").
    latestCountedVisit(cameraId: string): Visit | undefined {
        const row = this.db.prepare(`SELECT * FROM visits WHERE camera_id=? AND ${COUNTS_SQL} ORDER BY started_at DESC, id DESC LIMIT 1`).get(cameraId) as RawVisit | undefined;
        return row ? this.decodeVisit(row) : undefined;
    }

    // Fresh start for heard visits: removes every HEARD visit that started strictly before `before`
    // (ms), in one transaction, WITHOUT per-visit `visit_deleted` announcements (the caller sends one
    // compact event). Seen visits, corrections and learning embeddings are not touched (corrections
    // hold no foreign key to visits). The species of the removed visits are first remembered in
    // `known_species`, so hasSpecies stays true and nothing is flagged "first ever" again. With
    // `execute` false nothing changes: it only reports what would go.
    purgeHeardBefore(before: number, execute: boolean): PurgeResult {
        const rows = this.db.prepare("SELECT id, species, status, tier, started_at, birdnet_detection_id FROM visits WHERE kind='heard' AND started_at<? ORDER BY started_at, rowid")
            .all(before) as { id: string; species: string; status: VisitStatus; tier: Tier | null; started_at: number; birdnet_detection_id: number | null }[];
        const detectionIds = rows.map(row => row.birdnet_detection_id).filter((id): id is number => typeof id === 'number');
        const result: PurgeResult = {
            executed: execute, before, removed: rows.length, detectionIds,
            species: new Set(rows.map(row => row.species)).size, relinked: [],
            remainingHeard: Number((this.db.prepare("SELECT COUNT(*) AS n FROM visits WHERE kind='heard'").get() as { n: number }).n) - rows.length,
        };
        if (!execute || !rows.length) return result;
        const removedIds = new Set(rows.map(row => row.id));
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const remember = this.db.prepare(`INSERT INTO known_species(species,first_at,purged_at) VALUES(?,?,?)
                ON CONFLICT(species) DO UPDATE SET first_at=MIN(first_at,excluded.first_at)`);
            const now = Date.now();
            for (const row of rows) {
                if (row.status === 'not_animal' || row.status === 'unknown' || !counts(row)) continue;
                remember.run(row.species, row.started_at, now);
            }
            this.db.prepare("DELETE FROM visits WHERE kind='heard' AND started_at<?").run(before);
            const bestVisits = this.db.prepare('SELECT visit_id FROM species_best').all() as { visit_id: string }[];
            for (const { visit_id } of bestVisits) if (removedIds.has(visit_id)) this.refreshSpeciesBestForVisit(visit_id);
            // A kept seen visit may still point at a purged call.
            const linked = this.db.prepare("SELECT * FROM visits WHERE kind='seen' AND data LIKE '%\"heard\":{%'").all() as unknown as RawVisit[];
            for (const raw of linked) {
                const visit = this.decodeVisit(raw);
                if (!visit.heard || !removedIds.has(visit.heard.visitId)) continue;
                visit.heard = null;
                this.saveVisit(visit);
                result.relinked.push(visit.id);
            }
            this.db.exec('COMMIT');
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
        return result;
    }


    listVisits(filters: VisitFilters = {}): { items: Visit[]; next: number | null } {
        const clauses: string[] = [];
        const params: (string | number)[] = [];
        if (filters.camera) { clauses.push('camera_id=?'); params.push(filters.camera); }
        if (filters.species) { clauses.push('species=?'); params.push(filters.species); }
        if (filters.kind) { clauses.push('kind=?'); params.push(filters.kind); }
        if (filters.status) { clauses.push('status=?'); params.push(filters.status); }
        if (filters.before !== undefined && Number.isFinite(filters.before)) { clauses.push('started_at<?'); params.push(filters.before); }
        const limit = Math.min(50, Math.max(1, Math.floor(filters.limit ?? 50)));
        const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
        const rows = this.db.prepare(`SELECT * FROM visits ${where} ORDER BY started_at DESC,id DESC LIMIT ?`).all(...params, limit) as unknown as RawVisit[];
        const items = rows.map(row => this.decodeVisit(row));
        return { items, next: items.length === limit ? items[items.length - 1].startedAt : null };
    }

    // Species a person has confirmed (or corrected a visit to) at this camera since `since`, most often first,
    // excluding the visit's own species. Only human-verified visits count: a model's own unchecked output must not
    // become the list of birds it suggests next. A single GROUP BY, cheap enough to run at ingest.
    usualSpeciesAtCamera(cameraId: string, excludeSpecies: string, since: number, limit: number): string[] {
        const rows = this.db.prepare(`
            SELECT species FROM visits
            WHERE camera_id=? AND started_at>=? AND species<>? AND species<>'Unidentified animal'
            AND status IN ('confirmed','corrected')
            GROUP BY species ORDER BY COUNT(*) DESC, species ASC LIMIT ?
        `).all(cameraId, since, excludeSpecies, limit) as { species: string }[];
        return rows.map(row => row.species);
    }

    listReview(): Visit[] {
        return (this.db.prepare("SELECT * FROM visits WHERE review_flag=1 OR status='unknown' ORDER BY started_at DESC LIMIT 50").all() as unknown as RawVisit[]).map(row => this.decodeVisit(row));
    }

    listPendingClips(before: number, limit = 100): RawVisit[] {
        return this.db.prepare("SELECT * FROM visits WHERE kind='seen' AND clip_state='pending' AND started_at<=? ORDER BY started_at LIMIT ?").all(before, limit) as unknown as RawVisit[];
    }

    // Sets what a visit's clip is. A ready clip says where it came from (`source`), the wall-clock moment its first frame was recorded
    // (`startAt`, null when that cannot be told) and whether the file is Kestrel's own copy (`kept`, with its size); every other state
    // clears all of that. `deletedBy` records a deletion a person asked for. A deleted clip has nothing left to draw the detection boxes
    // on, so its track goes with it.
    setClip(id: string, state: ClipState, file: string | null, details: { source?: ClipSource; startAt?: number | null; kept?: boolean; bytes?: number | null; deletedBy?: 'user' } = {}): void {
        const row = this.getRawVisit(id);
        if (!row) return;
        const visit = this.decodeVisit(row);
        visit.clip.state = state;
        const ready = state === 'ready';
        this.saveVisit(visit, {
            clipFile: file,
            clipSource: ready ? details.source ?? null : null,
            clipStartAt: ready ? details.startAt ?? null : null,
            // A new or changed clip has not been looked at yet.
            clipOffsetMs: null,
            clipAlignedAt: null,
            clipKept: ready && !!details.kept,
            clipBytes: ready && details.kept ? details.bytes ?? null : null,
            clipDeletedBy: state === 'deleted' ? details.deletedBy ?? null : null,
        });
        if (state === 'deleted') this.deleteTrack(id);
    }

    // A ready clip whose file was another plugin's now has Kestrel's own copy: serve that one from now on.
    markClipKept(id: string, file: string, bytes: number): void {
        this.db.prepare("UPDATE visits SET clip_file=?,clip_kept=1,clip_bytes=?,updated_at=? WHERE id=? AND clip_state='ready'").run(file, bytes, Date.now(), id);
    }

    // What looking at a ready clip found (align.ts): the offset of its boxes in its video, null when the footage showed nothing clear, and when
    // it was looked at. Either way the clip is not looked at again until it is replaced (setClip clears both).
    setClipAlignment(id: string, offsetMs: number | null, at: number): void {
        this.db.prepare("UPDATE visits SET clip_offset_ms=?,clip_aligned_at=?,updated_at=? WHERE id=? AND clip_state='ready'").run(offsetMs, at, Date.now(), id);
    }

    // Seen visits whose ready clip has not been looked at yet and can be: the clip's start is known, its file is there (Kestrel's own copy, or
    // another plugin's file that still exists) and the visit kept at least ALIGN_MIN_SAMPLES detection events. Started at or after `since`,
    // newest first, at most `limit`.
    listUnaligned(since: number, limit: number): RawVisit[] {
        const rows = this.db.prepare(`SELECT * FROM visits v WHERE kind='seen' AND clip_state='ready' AND clip_start_at IS NOT NULL AND clip_aligned_at IS NULL AND started_at>=?
            AND (SELECT COUNT(*) FROM visit_boxes b WHERE b.visit_id=v.id)>=? ORDER BY started_at DESC`).all(since, ALIGN_MIN_SAMPLES) as unknown as RawVisit[];
        return rows.filter(row => row.clip_kept === 1 || (!!row.clip_file && existsSync(row.clip_file))).slice(0, limit);
    }

    // --- Detection boxes: what the detector drew around the animal during a visit (track.ts), one row per detection event ---

    // Adds detection events (oldest first) to a seen visit's track. A visit keeps at most TRACK_MAX_FRAMES events and none later than
    // TRACK_MAX_SPAN_MS after its first one: an event that would break either is dropped, and an event at a time that is already kept
    // is ignored. A visit that does not exist, that was only heard, or whose clip was deleted (nothing to draw on) has no track.
    appendTrackFrames(visitId: string, samples: readonly TrackSample[]): void {
        if (!samples.length) return;
        const visit = this.db.prepare('SELECT kind,clip_state FROM visits WHERE id=?').get(visitId) as { kind: VisitKind; clip_state: ClipState } | undefined;
        if (visit?.kind !== 'seen' || visit.clip_state === 'deleted') return;
        const stored = this.db.prepare('SELECT COUNT(*) AS n, MIN(t) AS first FROM visit_boxes WHERE visit_id=?').get(visitId) as { n: number; first: number | null };
        // Events older than everything kept move the first one back, and whatever then lies beyond the span from it goes.
        const first = Math.min(stored.first ?? samples[0].t, samples[0].t);
        let count = Number(stored.n);
        const insert = this.db.prepare('INSERT OR IGNORE INTO visit_boxes(visit_id,t,boxes) VALUES(?,?,?)');
        this.db.exec('BEGIN');
        try {
            if (stored.first !== null && first < stored.first)
                count -= Number(this.db.prepare('DELETE FROM visit_boxes WHERE visit_id=? AND t>?').run(visitId, first + TRACK_MAX_SPAN_MS).changes);
            for (const sample of samples) {
                if (count >= TRACK_MAX_FRAMES || sample.t - first > TRACK_MAX_SPAN_MS) break;
                count += Number(insert.run(visitId, sample.t, JSON.stringify(sample.boxes)).changes);
            }
            this.db.exec('COMMIT');
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }

    // A visit's track: when its clip starts (null when that was never recorded) and its detection events, oldest first. A row that
    // cannot be read is skipped.
    getTrack(visitId: string): VisitTrack {
        const clip = this.db.prepare('SELECT clip_start_at,clip_offset_ms FROM visits WHERE id=?').get(visitId) as { clip_start_at: number | null; clip_offset_ms: number | null } | undefined;
        const frames: TrackSample[] = [];
        for (const row of this.db.prepare('SELECT t,boxes FROM visit_boxes WHERE visit_id=? ORDER BY t').all(visitId) as { t: number; boxes: string }[]) {
            try {
                const boxes: unknown = JSON.parse(row.boxes);
                if (Array.isArray(boxes)) frames.push({ t: row.t, boxes: boxes as TrackBox[] });
            } catch {
                // Not JSON any more: this event is lost, the others are not.
            }
        }
        return { clipStartAt: clip?.clip_start_at ?? null, clipOffsetMs: clip?.clip_offset_ms ?? null, frames };
    }

    deleteTrack(visitId: string): void {
        this.db.prepare('DELETE FROM visit_boxes WHERE visit_id=?').run(visitId);
    }

    // Seen visits that ended with no clip but still have footage in the NVR (started at or after `since`), oldest first because the
    // oldest footage is the first to go. Only state 'none' qualifies: a clip a person deleted ('deleted') is final, heard visits never
    // have a clip, and a visit marked "not an animal" is not worth one.
    listBackfillCandidates(since: number, limit = 200): RawVisit[] {
        return this.db.prepare("SELECT * FROM visits WHERE kind='seen' AND clip_state='none' AND status<>'not_animal' AND started_at>=? ORDER BY started_at LIMIT ?")
            .all(since, limit) as unknown as RawVisit[];
    }

    // How many visits like those above are older than `since`, so their footage is gone from the NVR.
    countBackfillBeyond(since: number): number {
        const row = this.db.prepare("SELECT COUNT(*) AS n FROM visits WHERE kind='seen' AND clip_state='none' AND status<>'not_animal' AND started_at<?").get(since) as { n: number };
        return Number(row.n);
    }

    // Ready clips that are still another plugin's file (not yet copied into Kestrel's clip store), newest first.
    listUnkeptReadyClips(limit = 20): RawVisit[] {
        return this.db.prepare("SELECT * FROM visits WHERE clip_state='ready' AND clip_kept=0 ORDER BY started_at DESC LIMIT ?").all(limit) as unknown as RawVisit[];
    }

    // Every ready clip's file, `limit` at a time in id order after `afterId`: the check for files that went missing walks all of them.
    listReadyClipFiles(afterId: string, limit: number): { id: string; clip_file: string | null }[] {
        return this.db.prepare("SELECT id,clip_file FROM visits WHERE clip_state='ready' AND id>? ORDER BY id LIMIT ?").all(afterId, limit) as { id: string; clip_file: string | null }[];
    }

    // What Kestrel's own clip store holds (ready clips with Kestrel's own copy), optionally only visits started before `olderThan`.
    // `notAnimal` is visits marked "not an animal" or "can't tell"; `unconfirmed` is visits still carrying the model's own guess.
    clipStorage(olderThan?: number): { count: number; bytes: number; oldestAt: number | null; byReason: { notAnimal: { count: number; bytes: number }; unconfirmed: { count: number; bytes: number } } } {
        const row = this.db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(clip_bytes),0) AS bytes, MIN(started_at) AS oldest,
            COALESCE(SUM(CASE WHEN status IN ('not_animal','unknown') THEN 1 ELSE 0 END),0) AS na_n,
            COALESCE(SUM(CASE WHEN status IN ('not_animal','unknown') THEN clip_bytes ELSE 0 END),0) AS na_bytes,
            COALESCE(SUM(CASE WHEN status IN ('auto','learned') THEN 1 ELSE 0 END),0) AS uc_n,
            COALESCE(SUM(CASE WHEN status IN ('auto','learned') THEN clip_bytes ELSE 0 END),0) AS uc_bytes
            FROM visits WHERE clip_state='ready' AND clip_kept=1${olderThan === undefined ? '' : ' AND started_at<?'}`)
            .get(...(olderThan === undefined ? [] : [olderThan])) as { n: number; bytes: number; oldest: number | null; na_n: number; na_bytes: number; uc_n: number; uc_bytes: number };
        return {
            count: Number(row.n), bytes: Number(row.bytes), oldestAt: row.oldest === null ? null : Number(row.oldest),
            byReason: { notAnimal: { count: Number(row.na_n), bytes: Number(row.na_bytes) }, unconfirmed: { count: Number(row.uc_n), bytes: Number(row.uc_bytes) } },
        };
    }

    // The ready clips a delete request names. Ids that are not visits, or whose clip is not ready, simply do not match.
    clipsByIds(ids: readonly string[]): RawVisit[] {
        const rows: RawVisit[] = [];
        for (let index = 0; index < ids.length; index += 400) {
            const chunk = ids.slice(index, index + 400);
            rows.push(...this.db.prepare(`SELECT * FROM visits WHERE clip_state='ready' AND id IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as unknown as RawVisit[]);
        }
        return rows;
    }

    clipsStartedBefore(olderThan: number): RawVisit[] {
        return this.db.prepare("SELECT * FROM visits WHERE clip_state='ready' AND started_at<? ORDER BY started_at").all(olderThan) as unknown as RawVisit[];
    }

    clipsMarkedNotAnimal(): RawVisit[] {
        return this.db.prepare("SELECT * FROM visits WHERE clip_state='ready' AND status IN ('not_animal','unknown') ORDER BY started_at").all() as unknown as RawVisit[];
    }

    latestVisitForCamera(cameraId: string): RawVisit | undefined {
        return this.db.prepare('SELECT * FROM visits WHERE camera_id=? AND snapshot_file IS NOT NULL ORDER BY started_at DESC LIMIT 1').get(cameraId) as RawVisit | undefined;
    }

    latestVisitForSpecies(species: string): RawVisit | undefined {
        return this.db.prepare('SELECT * FROM visits WHERE species=? AND snapshot_file IS NOT NULL ORDER BY score DESC,started_at DESC LIMIT 1').get(species) as RawVisit | undefined;
    }

    speciesBestPath(species: string): string | null {
        const row = this.db.prepare('SELECT snapshot_file FROM species_best WHERE species=?').get(species) as { snapshot_file: string | null } | undefined;
        return row?.snapshot_file ?? null;
    }

    considerSpeciesBest(visit: Visit, snapshotFile: string | null, cropFile: string | null): void {
        if (!snapshotFile || visit.status === 'not_animal' || visit.status === 'unknown' || visit.grp === 'unknown')
            return;
        const prior = this.db.prepare('SELECT score FROM species_best WHERE species=?').get(visit.species) as { score: number | null } | undefined;
        if (prior && (prior.score ?? -1) >= (visit.score ?? -1))
            return;
        this.db.prepare(`INSERT INTO species_best(species,grp,visit_id,camera_id,snapshot_file,crop_file,score,updated_at)
            VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(species) DO UPDATE SET grp=excluded.grp,visit_id=excluded.visit_id,
            camera_id=excluded.camera_id,snapshot_file=excluded.snapshot_file,crop_file=excluded.crop_file,
            score=excluded.score,updated_at=excluded.updated_at`).run(
            visit.species, visit.grp, visit.id, visit.camera.id, snapshotFile, cropFile, visit.score, Date.now());
    }
    refreshSpeciesBestForVisit(visitId: string): void {
        const existing = this.db.prepare('SELECT species FROM species_best WHERE visit_id=?').all(visitId) as { species: string }[];
        for (const { species } of existing) {
            this.db.prepare('DELETE FROM species_best WHERE species=? AND visit_id=?').run(species, visitId);
            const best = this.db.prepare("SELECT * FROM visits WHERE species=? AND snapshot_file IS NOT NULL AND status NOT IN ('not_animal','unknown') AND grp<>'unknown' ORDER BY COALESCE(score,-1) DESC,started_at DESC LIMIT 1")
                .get(species) as RawVisit | undefined;
            if (best) this.db.prepare(
                'INSERT INTO species_best(species,grp,visit_id,camera_id,snapshot_file,crop_file,score,updated_at) VALUES(?,?,?,?,?,?,?,?)'
            ).run(best.species, best.grp, best.id, best.camera_id, best.snapshot_file, best.crop_file, best.score, Date.now());
        }
    }

    // The species list for a period: every species with a counted visit in it (all of them for 'all'). periodCount, periodSeen and
    // periodHeard count the visits inside the period; every other figure on an entry (first, last, count30d, hours...) stays all-time.
    speciesList(period: SpeciesPeriod = 'all', now = Date.now()): unknown[] {
        const rows = this.db.prepare(`SELECT species, grp, kind, started_at, camera_id FROM visits WHERE ${SPECIES_ROWS_SQL} ORDER BY started_at`).all() as unknown as SpeciesRow[];
        const photos = new Set((this.db.prepare('SELECT species FROM species_best').all() as { species: string }[]).map(row => row.species));
        return tallySpecies(rows, period, now, photos).filter(item => item.periodCount > 0).sort((a, b) => b.last - a.last);
    }

    // One species' entry of the all-time list, added up from that species' own visits (the species index finds them) instead of from every
    // visit there is: all a species sheet needs, so opening one does not cost as much as the whole list. Undefined when no counted visit names it.
    speciesEntry(species: string, now = Date.now()): SpeciesEntry | undefined {
        const rows = this.db.prepare(`SELECT species, grp, kind, started_at, camera_id FROM visits WHERE ${SPECIES_ROWS_SQL} AND species=? ORDER BY started_at`).all(species) as unknown as SpeciesRow[];
        const photos = new Set(this.db.prepare('SELECT 1 FROM species_best WHERE species=?').get(species) ? [species] : []);
        return tallySpecies(rows, 'all', now, photos)[0];
    }

    // The species list answer: its entries plus the period they cover and when it began (ms; null for 'all').
    speciesIndex(period: SpeciesPeriod = 'all', now = Date.now()): { items: unknown[]; period: SpeciesPeriod; since: number | null } {
        return { items: this.speciesList(period, now), period, since: periodStart(period, now) };
    }

    // What the species sheet adds to one species' list entry, from its counted visits: visits per New York day for the last 30 days, its
    // first visit ever (a purged call still counts) and last, its surest identification, and whether it is new to the home or to the season.
    speciesInsights(species: string, now = Date.now()): SpeciesInsights {
        const rows = `${SPECIES_ROWS_SQL} AND species=?`;
        const span = this.db.prepare(`SELECT MIN(started_at) AS first, MAX(started_at) AS last FROM visits WHERE ${rows}`).get(species) as { first: number | null; last: number | null };
        const purged = this.db.prepare('SELECT first_at FROM known_species WHERE species=?').get(species) as { first_at: number } | undefined;
        const firsts = [span.first, purged?.first_at].filter((at): at is number => typeof at === 'number');
        const firstAt = firsts.length ? Math.min(...firsts) : null;
        const best = this.db.prepare(`SELECT id, score FROM visits WHERE ${rows} AND score IS NOT NULL ORDER BY score DESC, started_at DESC LIMIT 1`).get(species) as { id: string; score: number } | undefined;

        const days = recentDayKeys(now, PER_DAY_COUNT);
        const dayIndex = new Map(days.map((day, index) => [day, index]));
        const perDay = Array<number>(PER_DAY_COUNT).fill(0);
        const { year, month, day } = newYorkParts(now);
        const recent = this.db.prepare(`SELECT started_at FROM visits WHERE ${rows} AND started_at>=?`)
            .all(species, newYorkMidnight(year, month, day - (PER_DAY_COUNT - 1))) as { started_at: number }[];
        for (const { started_at } of recent) {
            const index = dayIndex.get(newYorkDayKey(started_at));
            if (index !== undefined) perDay[index]++;
        }

        const { season, start } = seasonOf(now);
        const inSeason = this.db.prepare(`SELECT MIN(started_at) AS first FROM visits WHERE ${rows} AND started_at>=?`).get(species, start) as { first: number | null };
        const alreadyAround = !!this.db.prepare(`SELECT 1 FROM visits WHERE ${rows} AND started_at>=? AND started_at<? LIMIT 1`).get(species, start - SEASON_CARRYOVER_MS, start);
        return {
            perDay, perDayFrom: days[0], firstAt, lastAt: span.last,
            bestScore: best?.score ?? null, bestVisitId: best?.id ?? null,
            newThisSeason: inSeason.first !== null && now - inSeason.first <= NEW_WINDOW_MS && !alreadyAround,
            newToHome: firstAt !== null && now - firstAt <= NEW_WINDOW_MS,
            season, description: null, descriptionSource: null,
        };
    }

    // The period's latest, most frequent and least frequent species among the visits of `kind` (both kinds by default), the kind chosen
    // before anything is ranked. Each is shown by that species' newest visit in the period; `count` is its visits in the period and `total`
    // its visits ever (same kind). Ties go to the species seen newest; among the least frequent, to the one fewest visits ever.
    highlights(period: SpeciesPeriod = 'all', kind: HighlightKind = 'both', now = Date.now()): Highlights {
        const since = periodStart(period, now);
        const kindSql = kind === 'both' ? '' : ' AND kind=?';
        const kindArgs = kind === 'both' ? [] : [kind];
        const rows = this.db.prepare(`SELECT id, species, grp, kind, started_at FROM visits WHERE ${SPECIES_ROWS_SQL}${kindSql} AND started_at>=? ORDER BY started_at DESC, rowid DESC`)
            .all(...kindArgs, since ?? Number.MIN_SAFE_INTEGER) as unknown as HighlightRow[];
        const inPeriod = new Map<string, { newest: HighlightRow; count: number; total: number }>();
        for (const row of rows) {
            const entry = inPeriod.get(row.species);
            if (entry) entry.count++;
            else inPeriod.set(row.species, { newest: row, count: 1, total: 0 });
        }
        if (!inPeriod.size) return { period, kind, latest: null, top: null, rare: null };
        const totals = this.db.prepare(`SELECT species, COUNT(*) AS n FROM visits WHERE ${SPECIES_ROWS_SQL}${kindSql} GROUP BY species`).all(...kindArgs) as { species: string; n: number }[];
        for (const { species, n } of totals) {
            const entry = inPeriod.get(species);
            if (entry) entry.total = n;
        }
        const photos = new Set((this.db.prepare('SELECT species FROM species_best').all() as { species: string }[]).map(row => row.species));
        const highlight = ({ newest, count, total }: { newest: HighlightRow; count: number; total: number }): Highlight => ({
            species: newest.species, grp: newest.grp, kind: newest.kind, count, total, at: newest.started_at, visitId: newest.id, hasPhoto: photos.has(newest.species),
        });
        // The entries come newest visit first and sorting is stable, so any tie not broken below goes to the species seen newest.
        const entries = [...inPeriod.values()];
        const top = [...entries].sort((a, b) => b.count - a.count)[0];
        const rare = [...entries].sort((a, b) => a.count - b.count || a.total - b.total)[0];
        return { period, kind, latest: highlight(entries[0]), top: highlight(top), rare: highlight(rare) };
    }

    matchingVisits(cameraId: string, species: string, startedAt: number): RawVisit[] {
        return this.db.prepare('SELECT * FROM visits WHERE camera_id=? AND started_at BETWEEN ? AND ? AND species<>? ORDER BY ABS(started_at-?) LIMIT 5')
            .all(cameraId, startedAt - 120_000, startedAt + 120_000, species, startedAt) as unknown as RawVisit[];
    }

    recordCorrection(visit: Visit, from: string, to: string, confirmed: boolean, snapshotFile: string | null, cropFile: string | null): number {
        const result = this.db.prepare(`INSERT INTO corrections(visit_id,camera_id,at,from_label,to_label,score,confirmed,snapshot_file,crop_file)
            VALUES(?,?,?,?,?,?,?,?,?)`).run(visit.id, visit.camera.id, Date.now(), from, to, visit.score, Number(confirmed), snapshotFile, cropFile);
        return Number(result.lastInsertRowid);
    }

    deleteCorrection(id: number): void {
        this.db.prepare('DELETE FROM embeddings WHERE correction_id=?').run(id);
        this.db.prepare('DELETE FROM corrections WHERE id=?').run(id);
    }

    addEmbedding(correctionId: number, cameraId: string, from: string, to: string, embedding: Buffer): void {
        this.db.prepare('INSERT OR REPLACE INTO embeddings(correction_id,camera_id,from_label,to_label,embedding,created_at) VALUES(?,?,?,?,?,?)')
            .run(correctionId, cameraId, from, to, embedding, Date.now());
        this.db.prepare(`DELETE FROM embeddings WHERE correction_id IN (
            SELECT correction_id FROM embeddings ORDER BY created_at ASC LIMIT MAX(0,(SELECT COUNT(*) FROM embeddings)-?)
        )`).run(MAX_EMBEDDINGS);
    }

    learningExamples(cameraId: string, from: string): { cameraId: string; from: string; to: string; embedding: Buffer }[] {
        return (this.db.prepare('SELECT camera_id,from_label,to_label,embedding FROM embeddings WHERE camera_id=? AND from_label=? ORDER BY created_at DESC LIMIT ?')
            .all(cameraId, from, MAX_EMBEDDINGS) as { camera_id: string; from_label: string; to_label: string; embedding: Uint8Array }[])
            .map(row => ({ cameraId: row.camera_id, from: row.from_label, to: row.to_label, embedding: Buffer.from(row.embedding) }));
    }

    correctionStats(): { total: number; sinceRetrain: number; retrainedAt: number } {
        const retrainedAt = Number(this.getSetting('retrainedAt', '0')) || 0;
        const total = Number((this.db.prepare('SELECT COUNT(*) AS count FROM corrections').get() as { count: number }).count);
        const sinceRetrain = Number((this.db.prepare('SELECT COUNT(*) AS count FROM corrections WHERE at>?').get(retrainedAt) as { count: number }).count);
        return { total, sinceRetrain, retrainedAt };
    }

    correctionExport(): { items: { visitId: string; cameraId: string; at: number; from: string; to: string; score: number | null; crop: string; snapshot: string }[]; sinceRetrain: number } {
        const stats = this.correctionStats();
        const rows = this.db.prepare(`SELECT c.visit_id,c.camera_id,c.at,c.from_label,c.to_label,c.score,c.crop_file,c.snapshot_file
            FROM corrections c WHERE c.at>? AND c.crop_file IS NOT NULL AND c.snapshot_file IS NOT NULL ORDER BY c.at`)
            .all(stats.retrainedAt) as { visit_id: string; camera_id: string; at: number; from_label: string; to_label: string; score: number | null; crop_file: string; snapshot_file: string }[];
        return {
            items: rows.map(row => ({ visitId: row.visit_id, cameraId: row.camera_id, at: row.at, from: row.from_label, to: row.to_label,
                score: row.score, crop: `media/crop/${row.visit_id}.jpg`, snapshot: `media/snap/${row.visit_id}.jpg` })),
            sinceRetrain: stats.sinceRetrain,
        };
    }

    markRetrained(at: number): void {
        this.setSetting('retrainedAt', String(at));
    }

    findHeardOrSeen(cameraId: string, species: string, kind: VisitKind, at: number): RawVisit[] {
        const opposite = kind === 'seen' ? 'heard' : 'seen';
        return this.db.prepare('SELECT * FROM visits WHERE camera_id=? AND kind=? AND started_at BETWEEN ? AND ? ORDER BY CASE WHEN species=? THEN 0 ELSE 1 END,ABS(started_at-?) LIMIT 10')
            .all(cameraId, opposite, at - 120_000, at + 120_000, species, at) as unknown as RawVisit[];
    }

    allVisitsForCamera(cameraId: string, since: number): Visit[] {
        return (this.db.prepare('SELECT * FROM visits WHERE camera_id=? AND started_at>=? ORDER BY started_at DESC').all(cameraId, since) as unknown as RawVisit[]).map(row => this.decodeVisit(row));
    }

    recordDetectorCheck(cameraId: string, empty: boolean, at = Date.now()): void {
        const day = newYorkDayKey(at);
        this.recordDetectorCheckStatement.run(day, cameraId, Number(empty));
    }

    resetTodayDetectorCounts(at = Date.now()): void {
        const day = newYorkDayKey(at);
        this.db.prepare('UPDATE camera_daily_stats SET checks=0,empty_checks=0 WHERE day=?').run(day);
    }

    recordBirdnetIgnored(at = Date.now()): void {
        this.recordBirdnetIgnoredStatement.run(newYorkDayKey(at));
    }

    birdnetIgnoredToday(at = Date.now()): number {
        const row = this.db.prepare('SELECT ignored FROM birdnet_daily_stats WHERE day=?').get(newYorkDayKey(at)) as { ignored: number } | undefined;
        return row?.ignored ?? 0;
    }

    cameraDailyStats(cameraId: string, at = Date.now()): { checksToday: number; emptyChecksToday: number; visitsToday: number } {
        const range = newYorkDayBounds(at);
        this.db.prepare('INSERT OR IGNORE INTO camera_daily_stats(day,camera_id) VALUES(?,?)').run(range.day, cameraId);
        const row = this.db.prepare('SELECT checks,empty_checks FROM camera_daily_stats WHERE day=? AND camera_id=?')
            .get(range.day, cameraId) as { checks: number; empty_checks: number };
        const visitsToday = this.db.prepare('SELECT COUNT(*) AS count FROM visits WHERE camera_id=? AND started_at>=? AND started_at<?')
            .get(cameraId, range.start, range.end) as { count: number };
        return { checksToday: Number(row.checks), emptyChecksToday: Number(row.empty_checks), visitsToday: Number(visitsToday.count) };
    }

    appendEvent(type: EventItem['type'], data: unknown): EventItem {
        const result = this.db.prepare('INSERT INTO events(type,data,created_at) VALUES(?,?,?)').run(type, JSON.stringify(data), Date.now());
        const seq = Number(result.lastInsertRowid);
        this.db.prepare('DELETE FROM events WHERE seq <= (SELECT COALESCE(MAX(seq),0)-? FROM events)').run(MAX_EVENTS);
        return { seq, type, data };
    }

    eventsAfter(after: number): EventsResponse {
        const seq = Number((this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events').get() as { seq: number }).seq);
        const first = Number((this.db.prepare('SELECT COALESCE(MIN(seq),0) AS seq FROM events').get() as { seq: number }).seq);
        if (first && after < first - 1)
            return { seq, resync: true };
        const rows = this.db.prepare('SELECT seq,type,data FROM events WHERE seq>? ORDER BY seq LIMIT ?').all(after, MAX_EVENTS) as { seq: number; type: EventItem['type']; data: string }[];
        return { seq, events: rows.map(row => ({ seq: Number(row.seq), type: row.type, data: JSON.parse(row.data) })) };
    }

    currentSeq(): number {
        return Number((this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events').get() as { seq: number }).seq);
    }



    async prune(now: number, mediaDir: string, storageBudgetBytes: number): Promise<{ dbBytes: number; mediaBytes: number }> {
        const cutoff = now - 30 * 24 * 60 * 60 * 1000;
        this.db.prepare('DELETE FROM camera_daily_stats WHERE day<?').run(newYorkDayKey(now - 30 * 24 * 60 * 60 * 1000));
        this.db.prepare('DELETE FROM birdnet_daily_stats WHERE day<?').run(newYorkDayKey(now - 30 * 24 * 60 * 60 * 1000));
        this.db.prepare('DELETE FROM heard_calls WHERE at<?').run(now - HEARD_CALL_RETENTION_MS);
        // A visit that never got a clip and started more than 30 days ago is past any NVR retention, so no clip is coming for its boxes to
        // be drawn on. Every other track stays as long as its visit does (tracks of kept clips are not subject to the media pruning).
        this.db.prepare("DELETE FROM visit_boxes WHERE visit_id IN (SELECT id FROM visits WHERE clip_state='none' AND started_at<?)").run(cutoff);
        const old = this.db.prepare('SELECT id,snapshot_file,crop_file FROM visits WHERE started_at<? AND (snapshot_file IS NOT NULL OR crop_file IS NOT NULL)')
            .all(cutoff) as { id: string; snapshot_file: string | null; crop_file: string | null }[];
        for (const row of old) {
            if (row.snapshot_file) {
                const best = this.db.prepare('SELECT 1 FROM species_best WHERE snapshot_file=? LIMIT 1').get(row.snapshot_file);
                const correction = this.db.prepare('SELECT 1 FROM corrections WHERE snapshot_file=? LIMIT 1').get(row.snapshot_file);
                if (!best && !correction) {
                    await fs.unlink(row.snapshot_file).catch(() => undefined);
                    this.db.prepare('UPDATE visits SET snapshot_file=NULL WHERE id=?').run(row.id);
                }
            }
            if (row.crop_file) {
                const best = this.db.prepare('SELECT 1 FROM species_best WHERE crop_file=? LIMIT 1').get(row.crop_file);
                const correction = this.db.prepare('SELECT 1 FROM corrections WHERE crop_file=? LIMIT 1').get(row.crop_file);
                if (!best && !correction) {
                    await fs.unlink(row.crop_file).catch(() => undefined);
                    this.db.prepare('UPDATE visits SET crop_file=NULL WHERE id=?').run(row.id);
                }
            }
        }
        const expired = (this.db.prepare('SELECT id FROM visits WHERE started_at<?').all(now - VISIT_RETENTION_MS) as { id: string }[]).map(row => row.id);
        this.removeVisits(expired);
        const correctionCrops = this.db.prepare('SELECT id,visit_id,crop_file FROM corrections WHERE crop_file IS NOT NULL ORDER BY at DESC')
            .all() as { id: number; visit_id: string; crop_file: string }[];
        for (const correction of correctionCrops.slice(MAX_CORRECTION_CROPS)) {
            this.db.prepare('UPDATE corrections SET crop_file=NULL WHERE id=?').run(correction.id);
            const best = this.db.prepare('SELECT 1 FROM species_best WHERE crop_file=? LIMIT 1').get(correction.crop_file);
            const anotherCorrection = this.db.prepare('SELECT 1 FROM corrections WHERE crop_file=? LIMIT 1').get(correction.crop_file);
            if (!best && !anotherCorrection) {
                await fs.unlink(correction.crop_file).catch(() => undefined);
                this.db.prepare('UPDATE visits SET crop_file=NULL WHERE id=? AND crop_file=?').run(correction.visit_id, correction.crop_file);
            }
        }
        const mediaBytes = await this.pruneOversizedMedia(mediaDir, storageBudgetBytes);
        this.db.exec('PRAGMA optimize; PRAGMA incremental_vacuum(200);');
        const dbBytes = (await fs.stat(this.dbPath).catch(() => ({ size: 0 } as { size: number }))).size;
        return { dbBytes, mediaBytes };
    }

    private async pruneOversizedMedia(mediaDir: string, budget: number): Promise<number> {
        const files: { path: string; size: number; mtime: number; protected: boolean }[] = [];
        const walk = async (directory: string): Promise<void> => {
            for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
                const path = directory + '/' + entry.name;
                if (entry.isDirectory()) await walk(path);
                else if (entry.isFile()) {
                    // Kestrel's own kept clips are exempt from the budget: not counted, and never deleted here (only clips/delete removes them).
                    if (this.db.prepare('SELECT 1 FROM visits WHERE clip_kept=1 AND clip_file=? LIMIT 1').get(path)) continue;
                    const info = await fs.stat(path).catch(() => undefined);
                    if (!info) continue;
                    const protectedPath = !!this.db.prepare('SELECT 1 FROM species_best WHERE snapshot_file=? OR crop_file=? LIMIT 1').get(path, path)
                        || !!this.db.prepare('SELECT 1 FROM corrections WHERE snapshot_file=? OR crop_file=? LIMIT 1').get(path, path);
                    files.push({ path, size: info.size, mtime: info.mtimeMs, protected: protectedPath });
                }
            }
        };
        await walk(mediaDir);
        let total = files.reduce((sum, file) => sum + file.size, 0);
        files.sort((a, b) => Number(a.protected) - Number(b.protected) || a.mtime - b.mtime);
        for (const file of files) {
            if (total <= budget) break;
            await fs.unlink(file.path).catch(() => undefined);
            total -= file.size;
            this.db.prepare('UPDATE visits SET snapshot_file=CASE WHEN snapshot_file=? THEN NULL ELSE snapshot_file END,crop_file=CASE WHEN crop_file=? THEN NULL ELSE crop_file END,audio_file=CASE WHEN audio_file=? THEN NULL ELSE audio_file END WHERE snapshot_file=? OR crop_file=? OR audio_file=?')
                .run(file.path, file.path, file.path, file.path, file.path, file.path);
            this.db.prepare('UPDATE species_best SET snapshot_file=CASE WHEN snapshot_file=? THEN NULL ELSE snapshot_file END,crop_file=CASE WHEN crop_file=? THEN NULL ELSE crop_file END WHERE snapshot_file=? OR crop_file=?')
                .run(file.path, file.path, file.path, file.path);
            this.db.prepare('UPDATE corrections SET snapshot_file=CASE WHEN snapshot_file=? THEN NULL ELSE snapshot_file END,crop_file=CASE WHEN crop_file=? THEN NULL ELSE crop_file END WHERE snapshot_file=? OR crop_file=?')
                .run(file.path, file.path, file.path, file.path);
        }
        return total;
    }

    close(): void {
        this.db.close();
    }

}
