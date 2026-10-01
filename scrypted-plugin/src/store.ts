import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs/promises';
import type { StatementSync } from 'node:sqlite';

export type VisitKind = 'seen' | 'heard';
export type VisitGroup = 'bird' | 'mammal' | 'other' | 'unknown';
export type VisitStatus = 'auto' | 'learned' | 'corrected' | 'confirmed' | 'not_animal' | 'unknown';
export type ClipState = 'pending' | 'ready' | 'none' | 'deleted';

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
    clip: { state: ClipState; expectedReadyAt: number | null; url?: string };
    heard: { visitId: string; species: string; hasAudio: boolean; birdnetDetectionId: number | null; birdnetClip: string | null } | null;
    audio: { birdnetDetectionId: number | null; birdnetClip: string | null } | null;
    suggestions: { species: string; why: 'model' | 'heard' | 'usual' }[];
    firstEver: boolean;
    muted: boolean;
    notify: boolean;
    review?: boolean;
}

export interface VisitMeta {
    detectionLabel?: string | null;
    snapshotFile?: string | null;
    cropFile?: string | null;
    clipFile?: string | null;
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
    updated_at: number;
}

const MAX_EVENTS = 500;
const MAX_EMBEDDINGS = 5_000;
const MAX_CORRECTION_CROPS = 5_000;
const VISIT_RETENTION_MS = 3 * 365 * 24 * 60 * 60 * 1000;
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
        `);
        // One-time migration: the visits table predates these two columns (BirdNET-Go's
        // own detection reference), so a pre-existing on-disk DB needs them added explicitly --
        // CREATE TABLE IF NOT EXISTS above does not alter an existing table.
        const visitColumns = new Set((this.db.prepare('PRAGMA table_info(visits)').all() as { name: string }[]).map(column => column.name));
        if (!visitColumns.has('birdnet_detection_id')) this.db.exec('ALTER TABLE visits ADD COLUMN birdnet_detection_id INTEGER');
        if (!visitColumns.has('birdnet_clip')) this.db.exec('ALTER TABLE visits ADD COLUMN birdnet_clip TEXT');
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
            ...(row.clip_state === 'ready' ? { url: `media/clip/${row.id}.mp4` } : {}),
        };
        visit.review = !!row.review_flag;
        visit.firstEver = !!row.first_ever;
        visit.muted = !!row.muted;
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
        const audioFile = value('audioFile', prior?.audio_file) as string | null;
        const birdnetDetectionId = value('birdnetDetectionId', prior?.birdnet_detection_id) as number | null;
        const birdnetClip = value('birdnetClip', prior?.birdnet_clip) as string | null;
        const review = has('review') ? !!meta.review : !!prior?.review_flag;
        const data = JSON.stringify(visit);
        const updatedAt = Date.now();
        this.db.prepare(`INSERT INTO visits (
            id,camera_id,camera_name,kind,started_at,species,grp,status,score,detection_label,
            snapshot_file,crop_file,clip_file,audio_file,birdnet_detection_id,birdnet_clip,clip_state,clip_expected_ready_at,
            review_flag,first_ever,muted,data,last_change_at,undo_data,last_correction_id,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
            camera_id=excluded.camera_id,camera_name=excluded.camera_name,kind=excluded.kind,
            started_at=excluded.started_at,species=excluded.species,grp=excluded.grp,status=excluded.status,
            score=excluded.score,detection_label=excluded.detection_label,snapshot_file=excluded.snapshot_file,
            crop_file=excluded.crop_file,clip_file=excluded.clip_file,audio_file=excluded.audio_file,
            birdnet_detection_id=excluded.birdnet_detection_id,birdnet_clip=excluded.birdnet_clip,
            clip_state=excluded.clip_state,clip_expected_ready_at=excluded.clip_expected_ready_at,
            review_flag=excluded.review_flag,first_ever=excluded.first_ever,muted=excluded.muted,data=excluded.data,
            last_change_at=excluded.last_change_at,undo_data=excluded.undo_data,
            last_correction_id=excluded.last_correction_id,updated_at=excluded.updated_at`).run(
            visit.id, visit.camera.id, visit.camera.name, visit.kind, visit.startedAt, visit.species, visit.grp,
            visit.status, visit.score, has('detectionLabel') ? meta.detectionLabel ?? null : prior?.detection_label ?? null,
            snapshotFile, cropFile, clipFile, audioFile, birdnetDetectionId, birdnetClip, visit.clip.state, visit.clip.expectedReadyAt,
            Number(review), Number(visit.firstEver), Number(visit.muted), data,
            has('lastChangeAt') ? meta.lastChangeAt ?? null : prior?.last_change_at ?? null,
            has('undoData') ? meta.undoData ?? null : prior?.undo_data ?? null,
            has('lastCorrectionId') ? meta.lastCorrectionId ?? null : prior?.last_correction_id ?? null,
            updatedAt,
        );
    }

    private shouldNotify(visit: Visit): boolean {
        if (visit.muted)
            return false;
        if (visit.kind === 'seen')
            return true;
        return this.getSetting('heardNotify', 'new_only') !== 'never' && visit.firstEver;
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

    private recomputeFirstEverForSpecies(species: string): void {
        this.db.prepare('UPDATE visits SET first_ever=0 WHERE species=?').run(species);
        this.db.prepare('UPDATE visits SET first_ever=1 WHERE rowid=(SELECT rowid FROM visits WHERE species=? ORDER BY started_at ASC, rowid ASC LIMIT 1)').run(species);
    }

    // One-time repair for a raccoon that was filed twice (see seen.ts): folds `dropId` into
    // `keepId` -- the kept visit keeps its species, adopts the dropped visit's READY clip if it has
    // none, and offers the dropped visit's label as a 'model' suggestion -- then deletes the dropped
    // visit, its best-photo entry and its photo files. Not a user correction, so no corrections row
    // is written. 'absent' = one of the visits does not exist (nothing to repair); 'skipped' = they
    // are not a plain same-camera seen pair, or a correction points at the dropped visit.
    async repairSplitSeenVisit(keepId: string, dropId: string): Promise<'merged' | 'absent' | 'skipped'> {
        const keepRaw = this.getRawVisit(keepId);
        const dropRaw = this.getRawVisit(dropId);
        if (!keepRaw || !dropRaw) return 'absent';
        if (keepRaw.kind !== 'seen' || dropRaw.kind !== 'seen' || keepRaw.camera_id !== dropRaw.camera_id) return 'skipped';
        if (this.db.prepare('SELECT 1 FROM corrections WHERE visit_id=? LIMIT 1').get(dropId)) return 'skipped';
        const keep = this.decodeVisit(keepRaw);
        const drop = this.decodeVisit(dropRaw);
        let clipFile = keepRaw.clip_file;
        if (keep.clip.state !== 'ready' && drop.clip.state === 'ready' && dropRaw.clip_file) {
            keep.clip.state = 'ready';
            clipFile = dropRaw.clip_file;
        }
        if (drop.species !== keep.species && drop.species !== 'Unidentified animal')
            keep.suggestions = [{ species: drop.species, why: 'model' }, ...keep.suggestions.filter(item => item.species !== drop.species)];
        this.saveVisit(keep, { clipFile });
        const files = [dropRaw.snapshot_file, dropRaw.crop_file].filter((file): file is string => !!file);
        this.deleteVisitRow(dropId);
        this.recomputeFirstEverForSpecies(drop.species);
        this.recomputeFirstEverForSpecies(keep.species);
        await Promise.all(files.map(file => fs.rm(file, { force: true })));
        return 'merged';
    }

    hasSpecies(species: string): boolean {
        return !!this.db.prepare("SELECT 1 FROM visits WHERE species=? AND status NOT IN ('not_animal','unknown') LIMIT 1").get(species);
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

    // Species most often recorded (seen or heard) at this camera in the last `since`..now window,
    // excluding the visit's own species and anything that isn't a confirmed/auto animal ID. A
    // single GROUP BY, not a row fetch-and-count in JS -- cheap enough to run at ingest.
    usualSpeciesAtCamera(cameraId: string, excludeSpecies: string, since: number, limit: number): string[] {
        const rows = this.db.prepare(`
            SELECT species FROM visits
            WHERE camera_id=? AND started_at>=? AND species<>? AND species<>'Unidentified animal'
            AND status NOT IN ('not_animal','unknown')
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

    setClip(id: string, state: ClipState, file: string | null): void {
        const row = this.getRawVisit(id);
        if (!row) return;
        const visit = this.decodeVisit(row);
        visit.clip.state = state;
        this.saveVisit(visit, { clipFile: file });
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

    speciesList(): unknown[] {
        const rows = this.db.prepare("SELECT * FROM visits WHERE status NOT IN ('not_animal','unknown') AND species NOT IN ('Unidentified animal','unknown') ORDER BY started_at").all() as unknown as RawVisit[];
        const now = Date.now();
        const yearStart = new Date(new Date(now).getFullYear(), 0, 1).getTime();
        const species = new Map<string, {
            species: string; grp: VisitGroup; seen: boolean; heard: boolean; first: number; last: number;
            count30d: number; hasPhoto: boolean; cameras: Record<string, number>; hours: number[]; newThisYear: boolean;
            seenCount30d: number; heardCount30d: number;
            lastSeenAt: number | null; lastHeardAt: number | null; lastSeenCamera: string | null; lastHeardCamera: string | null;
        }>();
        const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
        for (const row of rows) {
            let item = species.get(row.species);
            if (!item) {
                item = { species: row.species, grp: row.grp, seen: false, heard: false, first: row.started_at, last: row.started_at,
                    count30d: 0, hasPhoto: false, cameras: {}, hours: Array(24).fill(0) as number[], newThisYear: row.started_at >= yearStart,
                    seenCount30d: 0, heardCount30d: 0, lastSeenAt: null, lastHeardAt: null, lastSeenCamera: null, lastHeardCamera: null };
                species.set(row.species, item);
            }
            item.seen ||= row.kind === 'seen';
            item.heard ||= row.kind === 'heard';
            item.first = Math.min(item.first, row.started_at);
            item.last = Math.max(item.last, row.started_at);
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
        const bestRows = this.db.prepare('SELECT species FROM species_best').all() as { species: string }[];
        for (const row of bestRows) {
            const item = species.get(row.species);
            if (item) item.hasPhoto = true;
        }
        return [...species.values()].sort((a, b) => b.last - a.last);
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
