// How a seen visit gets its clip, and what happens when the Events Recorder does not provide one. The decisions live here, away
// from the Scrypted SDK and the file system (main.ts supplies both through `ClipSources`), so the unit tests drive the very same
// code with fakes.
//
// Order of preference, always: the Events Recorder's clip first. Only a visit the Events Recorder has left without a clip once it
// is overdue gets one cut from the NVR's continuous recording, and only when that fails too does it end with no clip.

import type { ClipSource } from './store';

// The state a pending clip is given up in: no Events Recorder clip and no NVR cut either, five minutes after the visit started.
export const CLIP_GIVE_UP_MS = 5 * 60_000;
// The Events Recorder keeps recording up to 60 s of an event plus 10 s after it (its own settings), and a longer-than-usual event
// finishes its clip well after Kestrel's 45 s estimate. The NVR is only asked after that time, so a clip the Events Recorder is
// still writing is never pre-empted.
export const CLIP_NVR_AFTER_MS = 90_000;
// A failed NVR cut is tried again after this long (until the give-up time, which always gets one last try).
export const CLIP_NVR_RETRY_MS = 30_000;
// The NVR clip: from this long before the visit started to this long after its last detection, at most this long altogether.
export const NVR_LEAD_MS = 5_000;
export const NVR_TAIL_MS = 10_000;
export const NVR_MAX_CLIP_MS = 60_000;
// A visit does not record when its last detection was; unless the plugin watched it end, it is assumed to have lasted this long.
// The NVR's own "animal" events on the Backyard camera last 26-31 s, the Events Recorder's clips there 6-57 s.
export const NVR_ASSUMED_VISIT_MS = 20_000;
// Footage is kept for the NVR's "Video Retention (Days)"; when that is not a fixed period, look back this far (a try at footage
// that is gone fails at once, so too far costs nothing). The margin covers the NVR deleting a few hours later than the day count.
export const NVR_UNKNOWN_RETENTION_DAYS = 14;
export const NVR_RETENTION_MARGIN_MS = 12 * 3_600_000;

// What the resolver needs to know about a visit. `endedAt` is the last detection of the animal when the plugin watched it.
export interface ClipVisit { id: string; cameraId: string; startedAt: number; endedAt?: number }

export type NvrCut = { ok: true; file: string } | { ok: false; reason: 'unavailable' | 'failed' };

// Everything outside this file: main.ts answers these from Scrypted, the tests from fakes.
export interface ClipSources {
    // The Events Recorder's clip for the visit, if it has one: the file.
    events(visit: ClipVisit): Promise<string | undefined>;
    // Whether the NVR records this camera, so a clip can be cut from it.
    nvrRecords(cameraId: string): boolean;
    // Cuts the visit's clip out of the NVR's recording, into Kestrel's clip store. 'unavailable' means the NVR has no footage there.
    cutNvr(visit: ClipVisit): Promise<NvrCut>;
}

export type ClipVerdict =
    | { verdict: 'ready'; file: string; source: ClipSource }
    // Nothing yet, ask again at the next poll.
    | { verdict: 'wait' }
    | { verdict: 'none'; reason: 'no_nvr' | 'unavailable' | 'failed' };

const WAIT: ClipVerdict = { verdict: 'wait' };

// The span of footage to cut for a visit: [start, start + duration] in ms. Without an `endedAt` the visit is assumed to have
// lasted NVR_ASSUMED_VISIT_MS. A long visit is cut off at NVR_MAX_CLIP_MS.
export function nvrClipWindow(startedAt: number, endedAt?: number | null): { start: number; duration: number } {
    const start = startedAt - NVR_LEAD_MS;
    const visitEnd = endedAt != null && endedAt >= startedAt ? endedAt : startedAt + NVR_ASSUMED_VISIT_MS;
    return { start, duration: Math.min(visitEnd + NVR_TAIL_MS - start, NVR_MAX_CLIP_MS) };
}

// The oldest visit start the NVR can still have footage for.
export function backfillSince(now: number, retentionDays: number | undefined): number {
    const days = retentionDays !== undefined && retentionDays > 0 ? retentionDays : NVR_UNKNOWN_RETENTION_DAYS;
    return now - days * 86_400_000 - NVR_RETENTION_MARGIN_MS;
}

export class ClipResolver {
    private readonly sources: ClipSources;
    private readonly now: () => number;
    private readonly onError: (visit: ClipVisit, error: unknown) => void;
    // When the NVR was last asked for each pending visit.
    private readonly nvrTries = new Map<string, number>();

    constructor(sources: ClipSources, options: { now?: () => number; onError?: (visit: ClipVisit, error: unknown) => void } = {}) {
        this.sources = sources;
        this.now = options.now ?? Date.now;
        this.onError = options.onError ?? (() => undefined);
    }

    // One look at a pending visit (the poller runs this every few seconds). Events Recorder first; the NVR only once the visit is
    // overdue; 'none' only when the NVR cannot provide a clip either.
    async resolvePending(visit: ClipVisit): Promise<ClipVerdict> {
        const events = await this.sources.events(visit);
        if (events) {
            this.nvrTries.delete(visit.id);
            return { verdict: 'ready', file: events, source: 'events' };
        }
        const now = this.now();
        const age = now - visit.startedAt;
        if (age < CLIP_NVR_AFTER_MS) return WAIT;
        const lastChance = age >= CLIP_GIVE_UP_MS;
        if (!this.sources.nvrRecords(visit.cameraId)) return lastChance ? { verdict: 'none', reason: 'no_nvr' } : WAIT;
        const last = this.nvrTries.get(visit.id);
        if (!lastChance && last !== undefined && now - last < CLIP_NVR_RETRY_MS) return WAIT;
        this.nvrTries.set(visit.id, now);
        const cut = await this.cut(visit);
        if (cut.ok) {
            this.nvrTries.delete(visit.id);
            return { verdict: 'ready', file: cut.file, source: 'nvr' };
        }
        if (!lastChance) return WAIT;
        this.nvrTries.delete(visit.id);
        return { verdict: 'none', reason: cut.reason };
    }

    // A visit that already ended with no clip (the backfill): the same two sources in the same order, no waiting.
    async resolveMissing(visit: ClipVisit): Promise<ClipVerdict> {
        const events = await this.sources.events(visit);
        if (events) return { verdict: 'ready', file: events, source: 'events' };
        if (!this.sources.nvrRecords(visit.cameraId)) return { verdict: 'none', reason: 'no_nvr' };
        const cut = await this.cut(visit);
        return cut.ok ? { verdict: 'ready', file: cut.file, source: 'nvr' } : { verdict: 'none', reason: cut.reason };
    }

    // Forget the visits that are not pending any more.
    retainOnly(pendingIds: ReadonlySet<string>): void {
        for (const id of this.nvrTries.keys()) if (!pendingIds.has(id)) this.nvrTries.delete(id);
    }

    private async cut(visit: ClipVisit): Promise<NvrCut> {
        try {
            return await this.sources.cutNvr(visit);
        } catch (error) {
            this.onError(visit, error);
            return { ok: false, reason: 'failed' };
        }
    }
}

export interface PendingRow { id: string; camera_id: string; started_at: number }

export interface PendingPorts<Row extends PendingRow> {
    // The visits whose clip is still pending, oldest first.
    pending(): Row[];
    // When the animal was last seen, while the plugin watched the visit.
    endedAt(row: Row): number | undefined;
    resolve(visit: ClipVisit): Promise<ClipVerdict>;
    // Records the clip (the caller keeps its own copy and tells the dashboards).
    ready(row: Row, file: string, source: ClipSource): Promise<void>;
    // The visit ends with no clip.
    none(row: Row, reason: 'no_nvr' | 'unavailable' | 'failed'): void;
    failed(row: Row, error: unknown): void;
    stopped(): boolean;
}

// One poll of the pending clips, the loop the plugin runs every few seconds: every pending visit gets one look (Events Recorder first,
// the NVR once it is overdue) and what the look decides is carried out. Returns the ids that were pending.
export async function pollPendingClips<Row extends PendingRow>(ports: PendingPorts<Row>): Promise<string[]> {
    const rows = ports.pending();
    for (const row of rows) {
        if (ports.stopped()) break;
        try {
            const verdict = await ports.resolve({ id: row.id, cameraId: row.camera_id, startedAt: row.started_at, endedAt: ports.endedAt(row) });
            if (verdict.verdict === 'ready') await ports.ready(row, verdict.file, verdict.source);
            else if (verdict.verdict === 'none') ports.none(row, verdict.reason);
        } catch (error) {
            ports.failed(row, error);
        }
    }
    return rows.map(row => row.id);
}

export interface BackfillRow { id: string; camera_id: string; started_at: number }

export interface BackfillPorts<Row extends BackfillRow> {
    // Seen visits with no clip that the NVR may still have footage for, oldest first.
    candidates(): Row[];
    // How many visits with no clip are older than that: their footage is gone.
    beyondRetention(): number;
    resolve(visit: ClipVisit): Promise<ClipVerdict>;
    // Records the recovered clip (the caller sets the visit's state and tells the dashboards).
    recovered(row: Row, file: string, source: ClipSource): Promise<void>;
    stopped(): boolean;
}

export interface BackfillReport {
    candidates: number;
    recovered: { id: string; source: ClipSource }[];
    // The NVR answered that it no longer has the footage (or never recorded it).
    footageGone: string[];
    // The cut failed some other way; the next run tries again.
    failed: string[];
    // Cameras the NVR does not record.
    noNvr: string[];
    beyondRetention: number;
}

// Gives the visits that ended with no clip another chance. One at a time, oldest first: the oldest footage is the first to be
// deleted by the NVR.
export async function backfillClips<Row extends BackfillRow>(ports: BackfillPorts<Row>): Promise<BackfillReport> {
    const rows = ports.candidates();
    const report: BackfillReport = { candidates: rows.length, recovered: [], footageGone: [], failed: [], noNvr: [], beyondRetention: ports.beyondRetention() };
    for (const row of rows) {
        if (ports.stopped()) break;
        let verdict: ClipVerdict;
        try {
            verdict = await ports.resolve({ id: row.id, cameraId: row.camera_id, startedAt: row.started_at });
            if (verdict.verdict === 'ready') {
                await ports.recovered(row, verdict.file, verdict.source);
                report.recovered.push({ id: row.id, source: verdict.source });
                continue;
            }
        } catch {
            report.failed.push(row.id);
            continue;
        }
        if (verdict.verdict === 'none') {
            if (verdict.reason === 'unavailable') report.footageGone.push(row.id);
            else if (verdict.reason === 'no_nvr') report.noNvr.push(row.id);
            else report.failed.push(row.id);
        }
    }
    return report;
}
