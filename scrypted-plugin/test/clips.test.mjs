import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ClipKeeper, cutClip, encodeArguments, isInsideStore, keptClipFile, measuredFps, parseClipDelete, parseOlderThan, removeStalePartials, stopRunningCuts } from '../src/clipfiles.ts';
import {
    CLIP_GIVE_UP_MS, CLIP_NVR_AFTER_MS, CLIP_NVR_RETRY_MS, NVR_ASSUMED_VISIT_MS, NVR_LEAD_MS, NVR_MAX_CLIP_MS, NVR_RETENTION_MARGIN_MS, NVR_TAIL_MS,
    NVR_UNKNOWN_RETENTION_DAYS, ClipResolver, backfillClips, backfillSince, nvrClipWindow, pollPendingClips,
} from '../src/clips.ts';
import { SameMomentTracker } from '../src/seen.ts';
import { KestrelStore } from '../src/store.ts';

const DAY = 86_400_000;
const T0 = 1_791_507_668_972;           // the opossum on the Backyard camera, 2026-10-08 21:01:08 EDT

function visit(id, startedAt, { camera = '88', kind = 'seen', status = 'auto', clip = { state: 'none', expectedReadyAt: null } } = {}) {
    return {
        id, camera: { id: camera, name: camera === '88' ? 'Backyard Camera' : 'Back Door Camera' }, kind, startedAt, species: 'Virginia Opossum', grp: 'mammal', status, score: 0.8,
        snapshot: `media/snap/${id}.jpg`, crop: `media/crop/${id}.jpg`, clip, heard: null, audio: null, suggestions: [], firstEver: false, muted: false, notify: true,
    };
}

async function withStore(run) {
    const directory = await mkdtemp(join(tmpdir(), 'kestrel-clips-test-'));
    const store = new KestrelStore(join(directory, 'kestrel.sqlite'));
    try { await run(store, directory); }
    finally { store.close(); await rm(directory, { recursive: true, force: true }); }
}

// --- The window of footage cut for a visit -------------------------------------------------------------------------------------------

test('a clip starts 5 s before the visit and ends 10 s after it; an unknown end is assumed, a long visit is capped at 60 s', () => {
    assert.equal(NVR_LEAD_MS, 5_000);
    assert.equal(NVR_TAIL_MS, 10_000);
    assert.equal(NVR_MAX_CLIP_MS, 60_000);
    const unknown = nvrClipWindow(T0);
    assert.equal(unknown.start, T0 - 5_000);
    assert.equal(unknown.duration, 5_000 + NVR_ASSUMED_VISIT_MS + 10_000, 'the visit is assumed to have lasted 20 s');
    const short = nvrClipWindow(T0, T0 + 8_000);
    assert.deepEqual(short, { start: T0 - 5_000, duration: 5_000 + 8_000 + 10_000 }, 'known end: 5 s before, 10 s after the last detection');
    const single = nvrClipWindow(T0, T0);
    assert.equal(single.duration, 15_000, 'a visit with one detection is 15 s');
    const long = nvrClipWindow(T0, T0 + 50_000);
    assert.deepEqual(long, { start: T0 - 5_000, duration: 60_000 }, 'capped at 60 s');
    assert.deepEqual(nvrClipWindow(T0, T0 - 3_000), unknown, 'an end before the start is nonsense and is ignored');
    assert.deepEqual(nvrClipWindow(T0, null), unknown);
});

test('the backfill window follows the NVR retention (plus a margin), or a long look-back when the retention is not a fixed period', () => {
    const now = T0;
    assert.equal(backfillSince(now, 3), now - 3 * DAY - NVR_RETENTION_MARGIN_MS);
    assert.equal(backfillSince(now, 1), now - DAY - NVR_RETENTION_MARGIN_MS);
    assert.equal(backfillSince(now, undefined), now - NVR_UNKNOWN_RETENTION_DAYS * DAY - NVR_RETENTION_MARGIN_MS);
    assert.equal(backfillSince(now, 0), backfillSince(now, undefined));
    assert.equal(backfillSince(now, -2), backfillSince(now, undefined));
});

test('the tracker says when the animal was last seen, for the visit it is still inside', () => {
    const tracker = new SameMomentTracker();
    tracker.remember('88', 'visit-1', T0);
    assert.equal(tracker.lastSeen('88', 'visit-1'), T0, 'one detection: the visit ended where it began');
    tracker.touch('88', T0 + 4_000, 600_000);
    tracker.touch('88', T0 + 8_000, 600_000);
    assert.equal(tracker.lastSeen('88', 'visit-1'), T0 + 8_000);
    assert.equal(tracker.lastSeen('88', 'someone-else'), undefined);
    assert.equal(tracker.lastSeen('103', 'visit-1'), undefined, 'another camera');
    tracker.remember('88', 'visit-2', T0 + 300_000);
    assert.equal(tracker.lastSeen('88', 'visit-1'), undefined, 'once another visit took the camera over, the end is no longer known');
});

// --- The order clips are looked for in -----------------------------------------------------------------------------------------------

// Fake sources that write down every question they are asked, in order.
function fakes({ events = {}, records = true, nvr = () => ({ ok: true, file: '/NVR/kestrel/clips/88/cut.mp4' }) } = {}) {
    const calls = [];
    const sources = {
        async events(v) { calls.push(`events:${v.id}`); return events[v.id]; },
        nvrRecords(cameraId) { calls.push(`records:${cameraId}`); return records; },
        async cutNvr(v) {
            calls.push(`nvr:${v.id}`);
            const result = nvr(v);
            if (result instanceof Error) throw result;
            return result;
        },
    };
    return { calls, sources };
}

const pending = (id = 'v1', age = 0, extra = {}) => ({ id, cameraId: '88', startedAt: T0 - age, ...extra });
const resolverAt = (sources, clock, options = {}) => new ClipResolver(sources, { now: () => clock.now, ...options });

test('the Events Recorder is asked first and, when it has the clip, the NVR is never touched', async () => {
    const { calls, sources } = fakes({ events: { v1: '/NVR/clips/88/videoclips/1_2.mp4' } });
    const clock = { now: T0 + CLIP_GIVE_UP_MS + 60_000 };      // even a visit long past its give-up time keeps the Events Recorder's clip
    const verdict = await resolverAt(sources, clock).resolvePending(pending('v1', CLIP_GIVE_UP_MS + 60_000));
    assert.deepEqual(verdict, { verdict: 'ready', file: '/NVR/clips/88/videoclips/1_2.mp4', source: 'events' });
    assert.deepEqual(calls, ['events:v1']);
});

test('the NVR is only asked once the visit is overdue, and always after the Events Recorder was asked again', async () => {
    const { calls, sources } = fakes();
    const clock = { now: T0 };
    const resolver = resolverAt(sources, clock);
    clock.now = T0 + 1_000;
    assert.deepEqual(await resolver.resolvePending(pending()), { verdict: 'wait' });
    clock.now = T0 + CLIP_NVR_AFTER_MS - 1;
    assert.deepEqual(await resolver.resolvePending(pending()), { verdict: 'wait' }, 'the Events Recorder may still be writing a long clip');
    assert.deepEqual(calls, ['events:v1', 'events:v1'], 'only the Events Recorder was asked before the visit is overdue');
    calls.length = 0;
    clock.now = T0 + CLIP_NVR_AFTER_MS;
    const verdict = await resolver.resolvePending(pending());
    assert.deepEqual(verdict, { verdict: 'ready', file: '/NVR/kestrel/clips/88/cut.mp4', source: 'nvr' });
    assert.deepEqual(calls, ['events:v1', 'records:88', 'nvr:v1'], 'Events Recorder first, then the NVR');
});

test('a clip the Events Recorder finishes while the NVR is failing still wins', async () => {
    let failing = true;
    const events = {};
    const { calls, sources } = fakes({ events, nvr: () => failing ? { ok: false, reason: 'failed' } : { ok: true, file: '/x' } });
    const clock = { now: T0 + 100_000 };
    const resolver = resolverAt(sources, clock);
    assert.deepEqual(await resolver.resolvePending(pending()), { verdict: 'wait' });
    events.v1 = '/NVR/clips/88/videoclips/late.mp4';
    clock.now += CLIP_NVR_RETRY_MS + 1;
    assert.deepEqual(await resolver.resolvePending(pending()), { verdict: 'ready', file: '/NVR/clips/88/videoclips/late.mp4', source: 'events' });
    assert.equal(calls.filter(call => call === 'nvr:v1').length, 1, 'the NVR was only tried once');
    failing = false;
});

test('a failed NVR cut is retried every 30 s, not every poll', async () => {
    const { calls, sources } = fakes({ nvr: () => ({ ok: false, reason: 'failed' }) });
    const clock = { now: T0 + 100_000 };
    const resolver = resolverAt(sources, clock);
    const nvrCalls = () => calls.filter(call => call.startsWith('nvr:')).length;
    assert.deepEqual(await resolver.resolvePending(pending()), { verdict: 'wait' });
    assert.equal(nvrCalls(), 1);
    for (const step of [5_000, 10_000, 29_999]) {
        clock.now = T0 + 100_000 + step;
        assert.deepEqual(await resolver.resolvePending(pending()), { verdict: 'wait' });
    }
    assert.equal(nvrCalls(), 1, 'polls inside the retry spacing do not ask the NVR');
    clock.now = T0 + 100_000 + CLIP_NVR_RETRY_MS;
    await resolver.resolvePending(pending());
    assert.equal(nvrCalls(), 2);
});

test('a visit is given up on only after the NVR also failed, and the NVR gets one last try at the give-up time', async () => {
    const { calls, sources } = fakes({ nvr: () => ({ ok: false, reason: 'failed' }) });
    const clock = { now: T0 };
    const resolver = resolverAt(sources, clock);
    // Four minutes and a half: still waiting, never 'none', however often it is asked.
    for (const second of [95, 130, 170, 210, 250, 299]) {
        clock.now = T0 + second * 1000;
        assert.notEqual((await resolver.resolvePending(pending())).verdict, 'none', `at ${second} s`);
    }
    const triesBefore = calls.filter(call => call === 'nvr:v1').length;
    clock.now = T0 + 299_000 + 1_000;                       // 300 s: the last chance comes straight after a try 1 s ago
    const verdict = await resolver.resolvePending(pending());
    assert.deepEqual(verdict, { verdict: 'none', reason: 'failed' });
    assert.equal(calls.filter(call => call === 'nvr:v1').length, triesBefore + 1, 'the give-up poll asked the NVR once more, ignoring the retry spacing');
    assert.equal(calls[calls.length - 1], 'nvr:v1', 'and the NVR was the last thing asked');
});

test('a visit the NVR can cut at the give-up time is ready, not none', async () => {
    const { sources } = fakes();
    const clock = { now: T0 + CLIP_GIVE_UP_MS };
    assert.deepEqual(await resolverAt(sources, clock).resolvePending(pending()), { verdict: 'ready', file: '/NVR/kestrel/clips/88/cut.mp4', source: 'nvr' });
});

test('"the NVR has no footage" and "no NVR on this camera" end the visit with the reason', async () => {
    const gone = fakes({ nvr: () => ({ ok: false, reason: 'unavailable' }) });
    const clock = { now: T0 + CLIP_GIVE_UP_MS };
    assert.deepEqual(await resolverAt(gone.sources, clock).resolvePending(pending()), { verdict: 'none', reason: 'unavailable' });
    const noNvr = fakes({ records: false });
    assert.deepEqual(await resolverAt(noNvr.sources, clock).resolvePending(pending()), { verdict: 'none', reason: 'no_nvr' });
    assert.ok(!noNvr.calls.some(call => call.startsWith('nvr:')), 'a camera the NVR does not record is never asked for a cut');
    // Before the give-up time the same camera just waits (the Events Recorder may still deliver).
    clock.now = T0 + CLIP_NVR_AFTER_MS + 1_000;
    assert.deepEqual(await resolverAt(noNvr.sources, clock).resolvePending(pending()), { verdict: 'wait' });
});

test('an NVR cut that throws counts as a failure, is reported, and cannot end the visit before the give-up time', async () => {
    const errors = [];
    const { sources } = fakes({ nvr: () => new Error('boom') });
    const clock = { now: T0 + 120_000 };
    const resolver = resolverAt(sources, clock, { onError: (v, error) => errors.push([v.id, String(error)]) });
    assert.deepEqual(await resolver.resolvePending(pending()), { verdict: 'wait' });
    clock.now = T0 + CLIP_GIVE_UP_MS;
    assert.deepEqual(await resolver.resolvePending(pending()), { verdict: 'none', reason: 'failed' });
    assert.equal(errors.length, 2);
    assert.deepEqual(errors[0], ['v1', 'Error: boom']);
});

test('retry bookkeeping is dropped for visits that are not pending any more', async () => {
    const { calls, sources } = fakes({ nvr: () => ({ ok: false, reason: 'failed' }) });
    const clock = { now: T0 + 100_000 };
    const resolver = resolverAt(sources, clock);
    await resolver.resolvePending(pending());
    resolver.retainOnly(new Set());
    clock.now += 1_000;
    await resolver.resolvePending(pending());
    assert.equal(calls.filter(call => call === 'nvr:v1').length, 2, 'forgotten, so the very next poll asks the NVR again');
});

test('the backfill takes the same two sources in the same order, with no waiting', async () => {
    const { calls, sources } = fakes({ events: { found: '/NVR/clips/88/videoclips/found.mp4' } });
    const resolver = new ClipResolver(sources);
    assert.deepEqual(await resolver.resolveMissing(pending('found', 2 * DAY)), { verdict: 'ready', file: '/NVR/clips/88/videoclips/found.mp4', source: 'events' });
    assert.deepEqual(calls, ['events:found']);
    calls.length = 0;
    assert.deepEqual(await resolver.resolveMissing(pending('cut', 2 * DAY)), { verdict: 'ready', file: '/NVR/kestrel/clips/88/cut.mp4', source: 'nvr' });
    assert.deepEqual(calls, ['events:cut', 'records:88', 'nvr:cut']);
    const failing = fakes({ nvr: () => ({ ok: false, reason: 'unavailable' }) });
    assert.deepEqual(await new ClipResolver(failing.sources).resolveMissing(pending('gone', 2 * DAY)), { verdict: 'none', reason: 'unavailable' });
});

// --- Which visits the backfill picks -------------------------------------------------------------------------------------------------

test('backfill selection: only seen visits with no clip inside the NVR window; ready, deleted, pending, heard and not-an-animal visits are skipped', async () => {
    await withStore(async store => {
        const now = T0 + 3 * DAY;
        const since = backfillSince(now, 3);
        const none = { state: 'none', expectedReadyAt: null };
        const save = (id, startedAt, options = {}) => store.saveVisit(visit(id, startedAt, options));
        save('inside-new', now - 2 * 3_600_000);
        save('inside-old', since + 60_000);
        save('outside', since - 60_000);
        save('outside-ancient', now - 20 * DAY);
        save('ready-already', now - 3_600_000, { clip: { state: 'ready', expectedReadyAt: null } });
        store.setClip('ready-already', 'ready', '/NVR/clips/88/videoclips/x.mp4', { source: 'events' });
        save('deleted-by-user', now - 3_600_000);
        store.setClip('deleted-by-user', 'deleted', null, { deletedBy: 'user' });
        save('gone-missing', now - 3_600_000);
        store.setClip('gone-missing', 'deleted', null);
        save('still-pending', now - 60_000, { clip: { state: 'pending', expectedReadyAt: now } });
        save('heard-call', now - 3_600_000, { kind: 'heard', clip: none });
        save('not-an-animal', now - 3_600_000, { status: 'not_animal' });
        save('cant-tell', now - 3 * 3_600_000, { status: 'unknown' });
        save('other-camera', now - 5 * 3_600_000, { camera: '103' });

        assert.deepEqual(store.listBackfillCandidates(since).map(row => row.id), ['inside-old', 'other-camera', 'cant-tell', 'inside-new'], 'oldest first: the oldest footage goes first');
        assert.deepEqual(store.listBackfillCandidates(since, 2).map(row => row.id), ['inside-old', 'other-camera']);
        assert.equal(store.countBackfillBeyond(since), 2, 'two visits with no clip are older than the NVR window');
        // Visits a person deleted stay deleted, whatever the window.
        assert.ok(!store.listBackfillCandidates(0).some(row => row.id === 'deleted-by-user'));
        assert.ok(!store.listBackfillCandidates(0).some(row => row.id === 'gone-missing'), 'a vanished clip is not "no clip" either');
    });
});

test('the backfill walks the candidates oldest first, reports what happened, and stops when told to', async () => {
    const rows = [
        { id: 'a', camera_id: '88', started_at: 1 }, { id: 'b', camera_id: '88', started_at: 2 }, { id: 'c', camera_id: '88', started_at: 3 },
        { id: 'd', camera_id: '106', started_at: 4 }, { id: 'e', camera_id: '88', started_at: 5 }, { id: 'f', camera_id: '88', started_at: 6 },
    ];
    const verdicts = {
        a: { verdict: 'ready', file: '/s/a.mp4', source: 'nvr' }, b: { verdict: 'none', reason: 'unavailable' }, c: { verdict: 'ready', file: '/e/c.mp4', source: 'events' },
        d: { verdict: 'none', reason: 'no_nvr' }, e: { verdict: 'none', reason: 'failed' }, f: { verdict: 'ready', file: '/s/f.mp4', source: 'nvr' },
    };
    const asked = [];
    const stored = [];
    const report = await backfillClips({
        candidates: () => rows,
        beyondRetention: () => 7,
        resolve: async v => { asked.push(v.id); if (v.id === 'f') throw new Error('disk full'); return verdicts[v.id]; },
        recovered: async (row, file, source) => { stored.push([row.id, file, source]); },
        stopped: () => false,
    });
    assert.deepEqual(asked, ['a', 'b', 'c', 'd', 'e', 'f'], 'in the order given');
    assert.deepEqual(stored, [['a', '/s/a.mp4', 'nvr'], ['c', '/e/c.mp4', 'events']]);
    assert.deepEqual(report, {
        candidates: 6, recovered: [{ id: 'a', source: 'nvr' }, { id: 'c', source: 'events' }], footageGone: ['b'], failed: ['e', 'f'], noNvr: ['d'], beyondRetention: 7,
    });

    let calls = 0;
    const stopped = await backfillClips({ candidates: () => rows, beyondRetention: () => 0, resolve: async () => ({ verdict: 'none', reason: 'failed' }), recovered: async () => undefined, stopped: () => ++calls > 2 });
    assert.equal(stopped.failed.length, 2, 'it stopped when the plugin was released');
});

// --- What the visit data says about a clip ---------------------------------------------------------------------------------------------

test('a ready clip says where it came from; clips from before the source was recorded are Events Recorder clips; a person\'s deletion is marked', async () => {
    await withStore(store => {
        store.saveVisit(visit('legacy', T0));
        store.setClip('legacy', 'ready', '/NVR/clips/88/videoclips/old.mp4');
        assert.deepEqual(store.getVisit('legacy').clip, { state: 'ready', expectedReadyAt: null, url: 'media/clip/legacy.mp4', source: 'events' });
        store.saveVisit(visit('cut', T0 + 1));
        store.setClip('cut', 'ready', '/NVR/kestrel/clips/88/cut.mp4', { source: 'nvr', kept: true, bytes: 1234 });
        assert.deepEqual(store.getVisit('cut').clip, { state: 'ready', expectedReadyAt: null, url: 'media/clip/cut.mp4', source: 'nvr' });
        assert.equal(store.getRawVisit('cut').clip_kept, 1);
        assert.equal(store.getRawVisit('cut').clip_bytes, 1234);
        store.setClip('cut', 'deleted', null, { deletedBy: 'user' });
        assert.deepEqual(store.getVisit('cut').clip, { state: 'deleted', expectedReadyAt: null, deletedBy: 'user' });
        assert.equal(store.getRawVisit('cut').clip_kept, 0, 'a deleted clip is nobody\'s copy any more');
        assert.equal(store.getRawVisit('cut').clip_bytes, null);
        store.setClip('legacy', 'deleted', null);
        assert.deepEqual(store.getVisit('legacy').clip, { state: 'deleted', expectedReadyAt: null }, 'a file that went missing is not a person\'s deletion');
        // Saving the visit again for another reason (a correction) keeps the clip details.
        store.setClip('cut', 'ready', '/NVR/kestrel/clips/88/cut.mp4', { source: 'nvr', kept: true, bytes: 99 });
        store.saveVisit({ ...store.getVisit('cut'), species: 'Coyote' });
        assert.equal(store.getVisit('cut').clip.source, 'nvr');
        assert.equal(store.getRawVisit('cut').clip_bytes, 99);
    });
});

test('a database from before clips had a source gains the columns, and its ready clips read as Events Recorder clips', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kestrel-clips-old-'));
    try {
        const { DatabaseSync } = await import('node:sqlite');
        const path = join(directory, 'kestrel.sqlite');
        const old = new DatabaseSync(path);
        old.exec(`CREATE TABLE visits (id TEXT PRIMARY KEY, camera_id TEXT NOT NULL, camera_name TEXT NOT NULL, kind TEXT NOT NULL, started_at INTEGER NOT NULL, species TEXT NOT NULL,
            grp TEXT NOT NULL, status TEXT NOT NULL, score REAL, detection_label TEXT, snapshot_file TEXT, crop_file TEXT, clip_file TEXT, audio_file TEXT,
            clip_state TEXT NOT NULL DEFAULT 'pending', clip_expected_ready_at INTEGER, review_flag INTEGER NOT NULL DEFAULT 0, first_ever INTEGER NOT NULL DEFAULT 0,
            muted INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL, last_change_at INTEGER, undo_data TEXT, last_correction_id INTEGER, updated_at INTEGER NOT NULL)`);
        old.prepare(`INSERT INTO visits (id,camera_id,camera_name,kind,started_at,species,grp,status,clip_file,clip_state,data,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run('old-visit', '88', 'Backyard Camera', 'seen', T0, 'Coyote', 'mammal', 'auto', '/NVR/clips/88/videoclips/old.mp4', 'ready', JSON.stringify(visit('old-visit', T0)), T0);
        old.close();
        const store = new KestrelStore(path);
        try {
            const clip = store.getVisit('old-visit').clip;
            assert.equal(clip.state, 'ready');
            assert.equal(clip.source, 'events');
            assert.equal(store.getRawVisit('old-visit').clip_kept, 0, 'not yet copied into Kestrel\'s store');
            assert.deepEqual(store.listUnkeptReadyClips().map(row => row.id), ['old-visit']);
        } finally { store.close(); }
    } finally { await rm(directory, { recursive: true, force: true }); }
});

// --- Kestrel's own clip store ----------------------------------------------------------------------------------------------------------

test('a kept clip is /<camera>/<visit>.mp4 under the store, and only files inside the store count as the store\'s', () => {
    assert.equal(keptClipFile('/NVR/kestrel/clips', '88', 'abc-123'), '/NVR/kestrel/clips/88/abc-123.mp4');
    assert.equal(keptClipFile('/s', '../..', '../etc/passwd'), '/s/.._../.._etc_passwd.mp4', 'names cannot climb out of the store');
    assert.ok(isInsideStore('/NVR/kestrel/clips', '/NVR/kestrel/clips/88/abc.mp4'));
    assert.ok(!isInsideStore('/NVR/kestrel/clips', '/NVR/clips/88/videoclips/1_2.mp4'));
    assert.ok(!isInsideStore('/NVR/kestrel/clips', '/NVR/kestrel/clips/../../clips/88/x.mp4'));
    assert.ok(!isInsideStore('/NVR/kestrel/clips', '/NVR/kestrel/clips'), 'the store itself is not a clip');
    assert.ok(!isInsideStore('/NVR/kestrel/clips', '/NVR/kestrel/clips-other/88/x.mp4'));
});

// A keeper over a real store and real files in a temp directory.
async function withKeeper(run, options = {}) {
    await withStore(async (store, directory) => {
        const root = join(directory, 'store');
        const events = join(directory, 'events');
        await mkdir(root, { recursive: true });
        await mkdir(events, { recursive: true });
        const announced = [];
        const warnings = [];
        const keeper = new ClipKeeper({ store, root, announce: v => announced.push(v), warn: message => warnings.push(message) }, { quietMs: 0, ...options });
        const eventsClip = async (name, size = 1000) => {
            const file = join(events, `${name}.mp4`);
            await writeFile(file, Buffer.alloc(size, name.charCodeAt(0)));
            return file;
        };
        await run({ store, keeper, root, events, announced, warnings, eventsClip, directory });
    });
}

test('copy-on-ready: an Events Recorder clip is copied into Kestrel\'s store, the original is left alone, and the visit points at the copy', async () => {
    await withKeeper(async ({ store, keeper, root, announced, eventsClip }) => {
        store.saveVisit(visit('v1', T0, { clip: { state: 'pending', expectedReadyAt: T0 + 45_000 } }));
        const original = await eventsClip('a', 4321);
        await keeper.ready('v1', '88', original, 'events');
        const row = store.getRawVisit('v1');
        assert.equal(row.clip_state, 'ready');
        assert.equal(row.clip_file, join(root, '88', 'v1.mp4'));
        assert.equal(row.clip_kept, 1);
        assert.equal(row.clip_bytes, 4321);
        assert.equal(row.clip_source, 'events');
        assert.deepEqual(await readFile(row.clip_file), await readFile(original), 'a byte-for-byte copy');
        assert.equal((await stat(original)).size, 4321, 'the Events Recorder\'s own file is untouched');
        assert.deepEqual((await readdir(join(root, '88'))), ['v1.mp4'], 'no .part file is left behind');
        assert.equal(announced.length, 1);
        assert.equal(announced[0].id, 'v1');
        assert.equal(announced[0].clip.state, 'ready');
        assert.equal(announced[0].clip.source, 'events');
    });
});

test('copy-on-ready: a clip another plugin is still writing is copied only after it has been quiet, never half-written', async () => {
    await withKeeper(async ({ store, keeper, announced, eventsClip }) => {
        store.saveVisit(visit('v1', T0, { clip: { state: 'pending', expectedReadyAt: T0 + 45_000 } }));
        const original = await eventsClip('a', 100);
        const writer = (async () => {
            for (let step = 0; step < 3; step++) {
                await new Promise(resolve => setTimeout(resolve, 150));
                await appendFile(original, Buffer.alloc(100, 7));
            }
        })();
        const started = Date.now();
        await keeper.ready('v1', '88', original, 'events');
        await writer;
        const row = store.getRawVisit('v1');
        assert.equal(row.clip_bytes, 400, 'the copy has everything the writer wrote');
        assert.equal((await stat(row.clip_file)).size, 400);
        assert.ok(Date.now() - started >= 600, 'it waited for the writer to go quiet for 300 ms');
        assert.equal(announced.length, 1);
    }, { quietMs: 300 });
});

test('copy-on-ready: a clip the plugin cut itself is already in the store and is recorded as it is', async () => {
    await withKeeper(async ({ store, keeper, root, announced }) => {
        store.saveVisit(visit('v1', T0, { clip: { state: 'pending', expectedReadyAt: T0 + 45_000 } }));
        const cut = keptClipFile(root, '88', 'v1');
        await mkdir(join(root, '88'), { recursive: true });
        await writeFile(cut, Buffer.alloc(777, 1));
        await keeper.ready('v1', '88', cut, 'nvr');
        const row = store.getRawVisit('v1');
        assert.equal(row.clip_file, cut);
        assert.equal(row.clip_kept, 1);
        assert.equal(row.clip_bytes, 777);
        assert.equal(row.clip_source, 'nvr');
        assert.equal(announced[0].clip.source, 'nvr');
    });
});

test('copy-on-ready: when the copy fails the other plugin\'s file stays linked, the failure is reported, and the next sweep copies it', async () => {
    await withKeeper(async ({ store, keeper, root, announced, warnings, eventsClip }) => {
        store.saveVisit(visit('v1', T0, { clip: { state: 'pending', expectedReadyAt: T0 + 45_000 } }));
        const original = await eventsClip('a', 500);
        // A file where the camera folder should be: the copy cannot be made.
        await writeFile(join(root, '88'), 'in the way');
        await keeper.ready('v1', '88', original, 'events');
        let row = store.getRawVisit('v1');
        assert.equal(row.clip_state, 'ready', 'the visit still gets its clip');
        assert.equal(row.clip_file, original);
        assert.equal(row.clip_kept, 0);
        assert.equal(warnings.length, 1);
        assert.equal(announced.length, 1);
        await rm(join(root, '88'));
        await keeper.keepUnkept();
        row = store.getRawVisit('v1');
        assert.equal(row.clip_file, join(root, '88', 'v1.mp4'));
        assert.equal(row.clip_kept, 1);
        assert.equal(row.clip_bytes, 500);
    });
});

test('a copy that failed is left alone for the retry time, then tried again', async () => {
    let clock = 1_000;
    await withKeeper(async ({ store, keeper, root, warnings, eventsClip }) => {
        store.saveVisit(visit('v1', T0));
        store.setClip('v1', 'ready', await eventsClip('a', 500), { source: 'events' });
        await writeFile(join(root, '88'), 'in the way');
        await keeper.keepUnkept();
        await keeper.keepUnkept();
        assert.equal(warnings.length, 1, 'the second call did not try again');
        clock += 60_000;
        await keeper.keepUnkept();
        assert.equal(warnings.length, 1, 'still inside the retry time');
        clock += 600_000;
        await keeper.keepUnkept();
        assert.equal(warnings.length, 2, 'tried again after the retry time');
    }, { retryMs: 300_000, now: () => clock });
});

test('migration: the clips that were ready before the store existed are copied a few per call, newest first; one whose file is gone becomes deleted', async () => {
    await withKeeper(async ({ store, keeper, root, announced, eventsClip }) => {
        for (const [index, name] of ['a', 'b', 'c', 'd'].entries()) {
            store.saveVisit(visit(`v-${name}`, T0 + index * 1000));
            if (name !== 'c') store.setClip(`v-${name}`, 'ready', await eventsClip(name, 100 * (index + 1)));
        }
        store.setClip('v-c', 'ready', join(root, 'nowhere.mp4'));                 // its file is already gone
        await keeper.keepUnkept();
        assert.deepEqual(store.listUnkeptReadyClips().map(row => row.id), ['v-c', 'v-a'], 'two copied per call, the newest first (d, b), the vanished one skipped');
        await keeper.keepUnkept();
        assert.deepEqual(store.listUnkeptReadyClips().map(row => row.id), ['v-c']);
        keeper.checkVanished();
        assert.equal(store.getVisit('v-c').clip.state, 'deleted');
        assert.deepEqual(store.listUnkeptReadyClips(), []);
        for (const name of ['a', 'b', 'd']) {
            const row = store.getRawVisit(`v-${name}`);
            assert.equal(row.clip_file, join(root, '88', `v-${name}.mp4`));
            assert.equal(row.clip_kept, 1);
            assert.equal(store.getVisit(`v-${name}`).clip.source, 'events');
        }
        assert.equal(store.getRawVisit('v-b').clip_bytes, 200);
        assert.ok(announced.some(v => v.id === 'v-c' && v.clip.state === 'deleted'));
    }, { copiesPerCall: 2 });
});

test('the vanished-file check walks through ALL ready clips, not just the latest ones, and keeps working for kept clips', async () => {
    await withKeeper(async ({ store, keeper, root, announced, eventsClip }) => {
        const ids = [];
        for (let index = 0; index < 9; index++) {
            const id = `visit-${index}`;
            ids.push(id);
            store.saveVisit(visit(id, T0 - index * 60_000));           // visit-8 is the OLDEST
            const file = index % 2 ? await eventsClip(`k${index}`, 50) : keptClipFile(root, '88', id);
            if (index % 2 === 0) { await mkdir(join(root, '88'), { recursive: true }); await writeFile(file, 'kept clip'); }
            store.setClip(id, 'ready', file, { source: 'events', kept: index % 2 === 0, bytes: index % 2 === 0 ? 9 : null });
        }
        // Three files vanish: the oldest visit's, one in the middle, and the newest visit's (a kept clip).
        await rm(store.getRawVisit('visit-8').clip_file);
        await rm(store.getRawVisit('visit-3').clip_file);
        await rm(store.getRawVisit('visit-0').clip_file);
        for (let call = 0; call < 6; call++) keeper.checkVanished();   // batch of 2: five calls cover 9 clips, the sixth wraps around
        const states = Object.fromEntries(ids.map(id => [id, store.getVisit(id).clip.state]));
        assert.deepEqual(states, {
            'visit-0': 'deleted', 'visit-1': 'ready', 'visit-2': 'ready', 'visit-3': 'deleted', 'visit-4': 'ready', 'visit-5': 'ready', 'visit-6': 'ready', 'visit-7': 'ready', 'visit-8': 'deleted',
        });
        assert.equal(store.getVisit('visit-8').clip.deletedBy, undefined, 'a file that vanished is not a deletion by a person');
        assert.deepEqual(announced.map(v => v.id).sort(), ['visit-0', 'visit-3', 'visit-8']);
        assert.equal(store.getRawVisit('visit-0').clip_kept, 0);
    }, { checkBatch: 2 });
});

test('a disk that is not mounted is not a clean-out: kept clips missing together, or with the store itself gone, keep their links', async () => {
    await withKeeper(async ({ store, keeper, root, warnings, announced, eventsClip }) => {
        const keptIds = [];
        for (let index = 0; index < 6; index++) {
            const id = `kept-${index}`;
            keptIds.push(id);
            store.saveVisit(visit(id, T0 + index));
            const file = keptClipFile(root, '88', id);
            await mkdir(join(root, '88'), { recursive: true });
            await writeFile(file, 'kept');
            store.setClip(id, 'ready', file, { source: 'nvr', kept: true, bytes: 4 });
        }
        store.saveVisit(visit('foreign', T0 + 50));
        const foreign = await eventsClip('f', 10);
        store.setClip('foreign', 'ready', foreign, { source: 'events' });
        // The disk goes away (a restart that did not mount it): the store directory is gone, and so is another plugin's file.
        await rm(root, { recursive: true, force: true });
        await rm(foreign);
        keeper.checkVanished();
        assert.deepEqual(keptIds.map(id => store.getVisit(id).clip.state), Array(6).fill('ready'), 'not one kept clip was written off');
        assert.equal(store.getVisit('foreign').clip.state, 'deleted', 'another plugin\'s missing file still is');
        assert.deepEqual(announced.map(v => v.id), ['foreign']);
        // The disk comes back with the clips on it (the links never changed).
        await mkdir(join(root, '88'), { recursive: true });
        for (const id of keptIds) await writeFile(keptClipFile(root, '88', id), 'kept');
        keeper.checkVanished();
        assert.deepEqual(keptIds.map(id => store.getVisit(id).clip.state), Array(6).fill('ready'));
        assert.equal(warnings.length, 0, 'the store directory itself was missing, so nothing was even suspicious');

        // The store is there but five of six kept clips are gone at the same time: that is the disk, not five deletions.
        for (const id of keptIds.slice(0, 6)) await rm(keptClipFile(root, '88', id));
        keeper.checkVanished();
        assert.deepEqual(keptIds.map(id => store.getVisit(id).clip.state), Array(6).fill('ready'));
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /not mounted/);
        keeper.checkVanished();
        assert.equal(warnings.length, 1, 'said once, not at every poll');

        // A couple of clips deleted by hand while the rest are there is just that.
        for (const id of keptIds) await writeFile(keptClipFile(root, '88', id), 'kept');
        await rm(keptClipFile(root, '88', 'kept-1'));
        await rm(keptClipFile(root, '88', 'kept-4'));
        keeper.checkVanished();
        assert.deepEqual(keptIds.map(id => store.getVisit(id).clip.state), ['ready', 'deleted', 'ready', 'ready', 'deleted', 'ready']);
        assert.ok(keeper.isGone(null));
        assert.ok(!keeper.isGone(keptClipFile(root, '88', 'kept-0')));
        assert.ok(keeper.isGone(keptClipFile(root, '88', 'kept-1')));
        assert.ok(keeper.isGone('/somewhere/else/clip.mp4'), 'another plugin\'s missing file is gone');
        await rm(root, { recursive: true, force: true });
        assert.ok(!keeper.isGone(keptClipFile(root, '88', 'kept-0')), 'with the store missing, one of its clips is not gone, just unreachable');
    });
});

// --- The whole poll, as the plugin runs it: a new visit, step by step ------------------------------------------------------------------------

// pollPendingClips is main.ts's own loop; here it runs over a real store, the real keeper and the real resolver, with only the two
// outside sources (the Events Recorder's folder and the NVR) faked.
function pollerFor({ store, keeper, clock, sources }) {
    const resolver = resolverAt(sources, clock);
    const nones = [];
    return {
        nones,
        poll: () => pollPendingClips({
            pending: () => store.listPendingClips(clock.now, 100),
            endedAt: () => undefined,
            resolve: v => resolver.resolvePending(v),
            ready: (row, file, source) => keeper.ready(row.id, row.camera_id, file, source),
            none: (row, reason) => { nones.push([row.id, reason]); store.setClip(row.id, 'none', null); },
            failed: (row, error) => { throw error; },
            stopped: () => false,
        }),
    };
}

test('a new visit gets the Events Recorder\'s clip when it appears: kept in Kestrel\'s store, source "events", the NVR never asked', async () => {
    await withKeeper(async ({ store, keeper, root, eventsClip, announced }) => {
        store.saveVisit(visit('v1', T0, { clip: { state: 'pending', expectedReadyAt: T0 + 45_000 } }));
        const events = {};
        const { calls, sources } = fakes({ events });
        const clock = { now: T0 + 1_000 };
        const { poll } = pollerFor({ store, keeper, clock, sources });
        await poll();
        assert.equal(store.getVisit('v1').clip.state, 'pending', 'nothing yet one second in');
        events.v1 = await eventsClip('v1', 5000);                  // the Events Recorder finishes its clip
        clock.now = T0 + 20_000;
        await poll();
        const stored = store.getVisit('v1');
        assert.deepEqual(stored.clip, { state: 'ready', expectedReadyAt: T0 + 45_000, url: 'media/clip/v1.mp4', source: 'events' });
        const row = store.getRawVisit('v1');
        assert.equal(row.clip_file, join(root, '88', 'v1.mp4'), 'Kestrel\'s own copy is what the visit serves');
        assert.equal(row.clip_kept, 1);
        assert.deepEqual(await readFile(row.clip_file), await readFile(events.v1));
        assert.ok(!calls.some(call => call.startsWith('nvr:') || call.startsWith('records:')), 'the NVR was never asked');
        assert.deepEqual(announced.map(v => v.id), ['v1']);
        await poll();
        assert.deepEqual(announced.map(v => v.id), ['v1'], 'and nothing more happens at the next poll');
    });
});

test('a new visit the Events Recorder never clips gets an NVR clip once overdue, in the same store, source "nvr"', async () => {
    await withKeeper(async ({ store, keeper, root, announced }) => {
        store.saveVisit(visit('v2', T0, { clip: { state: 'pending', expectedReadyAt: T0 + 45_000 } }));
        const cut = async v => {
            const file = keptClipFile(root, '88', v.id);
            await mkdir(join(root, '88'), { recursive: true });
            await writeFile(file, Buffer.alloc(2048, 3));
            return { ok: true, file };
        };
        const { calls, sources } = fakes({ nvr: cut });
        const clock = { now: T0 + 60_000 };
        const { poll } = pollerFor({ store, keeper, clock, sources });
        await poll();
        assert.equal(store.getVisit('v2').clip.state, 'pending', 'a minute in the Events Recorder may still be writing: the NVR is not asked');
        assert.ok(!calls.some(call => call.startsWith('nvr:')));
        clock.now = T0 + CLIP_NVR_AFTER_MS + 5_000;
        await poll();
        const row = store.getRawVisit('v2');
        assert.equal(row.clip_state, 'ready');
        assert.equal(row.clip_source, 'nvr');
        assert.equal(row.clip_kept, 1);
        assert.equal(row.clip_bytes, 2048);
        assert.equal(store.getVisit('v2').clip.source, 'nvr');
        assert.deepEqual(calls.slice(-3), ['events:v2', 'records:88', 'nvr:v2'], 'the Events Recorder was asked right before the NVR');
        assert.equal(announced.length, 1);
    });
});

test('a new visit nobody can give a clip ends with none only after five minutes and a failed last NVR try', async () => {
    await withKeeper(async ({ store, keeper }) => {
        store.saveVisit(visit('v3', T0, { clip: { state: 'pending', expectedReadyAt: T0 + 45_000 } }));
        const { calls, sources } = fakes({ nvr: () => ({ ok: false, reason: 'unavailable' }) });
        const clock = { now: T0 };
        const { poll, nones } = pollerFor({ store, keeper, clock, sources });
        for (const second of [5, 60, 95, 130, 200, 299]) {
            clock.now = T0 + second * 1000;
            await poll();
            assert.equal(store.getVisit('v3').clip.state, 'pending', `still pending at ${second} s`);
        }
        assert.deepEqual(nones, []);
        clock.now = T0 + CLIP_GIVE_UP_MS;
        await poll();
        assert.deepEqual(nones, [['v3', 'unavailable']]);
        assert.deepEqual(store.getVisit('v3').clip, { state: 'none', expectedReadyAt: T0 + 45_000 });
        assert.equal(calls[calls.length - 1], 'nvr:v3', 'the NVR was the last thing asked');
        assert.deepEqual(store.listBackfillCandidates(0).map(row => row.id), ['v3'], 'and the backfill will look again while the NVR has footage');
    });
});

// --- Deleting clips on request ---------------------------------------------------------------------------------------------------------

async function seedKept({ store, keeper, eventsClip }, specs) {
    for (const spec of specs) {
        store.saveVisit(visit(spec.id, spec.at, { status: spec.status ?? 'auto' }), { snapshotFile: `/media/snap/${spec.id}.jpg`, cropFile: `/media/crop/${spec.id}.jpg` });
        store.setClip(spec.id, 'pending', null);
        await keeper.ready(spec.id, '88', await eventsClip(spec.id, spec.size ?? 1000), spec.source ?? 'events');
    }
}

test('delete by visit ids: the files go, the clips become deleted by the user, the visits stay, and the others are untouched', async () => {
    await withKeeper(async context => {
        const { store, keeper, announced } = context;
        await seedKept(context, [{ id: 'a', at: T0, size: 100 }, { id: 'b', at: T0 + 1, size: 200 }, { id: 'c', at: T0 + 2, size: 400 }]);
        store.setClip('c', 'ready', store.getRawVisit('c').clip_file, { source: 'nvr', kept: true, bytes: 400 });
        announced.length = 0;
        const result = await keeper.remove({ visitIds: ['a', 'b', 'no-such-visit'] });
        assert.deepEqual(result, { deleted: 2, freedBytes: 300 });
        for (const id of ['a', 'b']) {
            const stored = store.getVisit(id);
            assert.deepEqual(stored.clip, { state: 'deleted', expectedReadyAt: null, deletedBy: 'user' });
            assert.equal(stored.species, 'Virginia Opossum', 'the visit itself is kept');
            assert.equal(stored.snapshot, `media/snap/${id}.jpg`, 'and its photos');
            assert.equal(store.getRawVisit(id).clip_file, null);
        }
        assert.equal(store.getVisit('c').clip.state, 'ready');
        assert.deepEqual(announced.map(v => v.id).sort(), ['a', 'b'], 'one visit_updated per visit');
        assert.ok(announced.every(v => v.clip.deletedBy === 'user'));
        assert.deepEqual((await readdir(join(context.root, '88'))).sort(), ['c.mp4']);
        assert.deepEqual(await keeper.remove({ visitIds: ['a', 'b'] }), { deleted: 0, freedBytes: 0 }, 'a clip that is already deleted is not deleted again');
        // A deleted clip is final: the backfill never offers it again.
        assert.ok(!store.listBackfillCandidates(0).some(row => row.id === 'a'));
    });
});

test('delete older than a date: only the visits that started before it', async () => {
    await withKeeper(async context => {
        const { store, keeper } = context;
        await seedKept(context, [{ id: 'old1', at: 1_000, size: 10 }, { id: 'old2', at: 2_000, size: 20 }, { id: 'edge', at: 3_000, size: 40 }, { id: 'new', at: 4_000, size: 80 }]);
        const result = await keeper.remove({ olderThan: 3_000 });
        assert.deepEqual(result, { deleted: 2, freedBytes: 30 }, 'a visit that started exactly at the cut-off is not older than it');
        assert.deepEqual(['old1', 'old2', 'edge', 'new'].map(id => store.getVisit(id).clip.state), ['deleted', 'deleted', 'ready', 'ready']);
    });
});

test('delete "not an animal": visits marked not an animal or can\'t tell lose their clips, everything else keeps them', async () => {
    await withKeeper(async context => {
        const { store, keeper } = context;
        await seedKept(context, [
            { id: 'na', at: 1, status: 'not_animal', size: 11 }, { id: 'unk', at: 2, status: 'unknown', size: 22 }, { id: 'auto', at: 3, status: 'auto', size: 44 },
            { id: 'learned', at: 4, status: 'learned', size: 88 }, { id: 'confirmed', at: 5, status: 'confirmed', size: 176 }, { id: 'corrected', at: 6, status: 'corrected', size: 352 },
        ]);
        assert.deepEqual(await keeper.remove({ reason: 'notAnimal' }), { deleted: 2, freedBytes: 33 });
        assert.deepEqual(['na', 'unk', 'auto', 'learned', 'confirmed', 'corrected'].map(id => store.getVisit(id).clip.state), ['deleted', 'deleted', 'ready', 'ready', 'ready', 'ready']);
    });
});

test('delete never removes a file that is not Kestrel\'s own, and leaves a clip alone when its file cannot be removed', async () => {
    await withKeeper(async context => {
        const { store, keeper, root, warnings, eventsClip } = context;
        // 1. A ready clip that is still the Events Recorder's file (the copy has not happened yet).
        store.saveVisit(visit('foreign', T0));
        const foreign = await eventsClip('f', 700);
        store.setClip('foreign', 'ready', foreign, { source: 'events' });
        // 2. A kept clip whose path is a directory: rm cannot remove it.
        store.saveVisit(visit('stuck', T0 + 1));
        const stuck = keptClipFile(root, '88', 'stuck');
        await mkdir(join(stuck, 'inside'), { recursive: true });
        store.setClip('stuck', 'ready', stuck, { source: 'nvr', kept: true, bytes: 5 });
        // 3. A "kept" row whose path points outside the store (a damaged row): never removed.
        store.saveVisit(visit('outside', T0 + 2));
        const outside = await eventsClip('o', 900);
        store.setClip('outside', 'ready', outside, { source: 'events', kept: true, bytes: 900 });
        const result = await keeper.remove({ visitIds: ['foreign', 'stuck', 'outside'] });
        assert.deepEqual(result, { deleted: 2, freedBytes: 0 });
        assert.equal((await stat(foreign)).size, 700, 'the Events Recorder\'s file is still there');
        assert.equal((await stat(outside)).size, 900, 'so is a file outside the store');
        assert.equal(store.getVisit('foreign').clip.state, 'deleted');
        assert.equal(store.getVisit('outside').clip.state, 'deleted');
        assert.equal(store.getVisit('stuck').clip.state, 'ready', 'a clip whose file cannot be removed stays as it was');
        assert.equal(warnings.length, 1);
    });
});

test('delete requests: exactly one of visitIds, olderThan or reason, and anything else is a 400', () => {
    const now = T0;
    assert.deepEqual(parseClipDelete({ visitIds: ['a', 'b', 'a'] }, now), { visitIds: ['a', 'b'] });
    assert.deepEqual(parseClipDelete({ olderThan: now - DAY }, now), { olderThan: now - DAY });
    assert.deepEqual(parseClipDelete({ reason: 'notAnimal' }, now), { reason: 'notAnimal' });
    const bad = [
        {}, { visitIds: ['a'], olderThan: now - 1 }, { reason: 'notAnimal', visitIds: ['a'] }, { visitIds: [] }, { visitIds: 'a' }, { visitIds: [1] }, { visitIds: [''] }, { visitIds: [null] },
        { visitIds: Array.from({ length: 1001 }, (_, index) => `id-${index}`) }, { olderThan: 'yesterday' }, { olderThan: String(now - DAY) }, { olderThan: 0 }, { olderThan: -5 },
        { olderThan: now + DAY }, { olderThan: Number.NaN }, { olderThan: null }, { reason: 'unconfirmed' }, { reason: 'all' }, { reason: 5 }, { everything: true }, { olderThan: now - DAY, extra: 1 },
    ];
    for (const body of bad) {
        assert.throws(() => parseClipDelete(body, now), error => error.status === 400, JSON.stringify(body).slice(0, 80));
    }
    assert.equal(parseOlderThan(String(now - DAY), now), now - DAY, 'a query string number is fine');
    assert.equal(parseOlderThan(`${now - DAY}.0`, now), now - DAY, 'and so is one a client wrote as a float');
    assert.throws(() => parseOlderThan('', now), error => error.status === 400);
    assert.throws(() => parseOlderThan('1e12', now), error => error.status === 400, 'no exponent forms');
    assert.throws(() => parseOlderThan('-5', now), error => error.status === 400);
    assert.throws(() => parseOlderThan('abc', now), error => error.status === 400);
    assert.throws(() => parseOlderThan(String(now + DAY), now), error => error.status === 400);
});

// --- What the store holds ---------------------------------------------------------------------------------------------------------------

test('storage: the clips Kestrel holds, how big they are, how old the oldest is, and how many belong to visits nobody confirmed or that are not animals', async () => {
    await withKeeper(async context => {
        const { store, keeper, eventsClip } = context;
        assert.deepEqual(store.clipStorage(), { count: 0, bytes: 0, oldestAt: null, byReason: { notAnimal: { count: 0, bytes: 0 }, unconfirmed: { count: 0, bytes: 0 } } });
        await seedKept(context, [
            { id: 'auto', at: 5_000, status: 'auto', size: 1 }, { id: 'learned', at: 4_000, status: 'learned', size: 2 }, { id: 'na', at: 3_000, status: 'not_animal', size: 4 },
            { id: 'unk', at: 2_000, status: 'unknown', size: 8 }, { id: 'confirmed', at: 1_000, status: 'confirmed', size: 16 }, { id: 'corrected', at: 6_000, status: 'corrected', size: 32 },
        ]);
        // A ready clip that is still another plugin's file, a deleted clip and a visit with no clip are not in the store.
        store.saveVisit(visit('foreign', 500));
        store.setClip('foreign', 'ready', await eventsClip('x', 64));
        store.saveVisit(visit('gone', 400));
        store.setClip('gone', 'deleted', null, { deletedBy: 'user' });
        store.saveVisit(visit('none', 300));
        const everything = { count: 6, bytes: 63, oldestAt: 1_000, byReason: { notAnimal: { count: 2, bytes: 12 }, unconfirmed: { count: 2, bytes: 3 } } };
        assert.deepEqual(store.clipStorage(), everything);
        assert.deepEqual(store.clipStorage(4_000), { count: 3, bytes: 28, oldestAt: 1_000, byReason: { notAnimal: { count: 2, bytes: 12 }, unconfirmed: { count: 0, bytes: 0 } } }, 'only visits that started before 4000');
        assert.deepEqual(store.clipStorage(1_000), { count: 0, bytes: 0, oldestAt: null, byReason: { notAnimal: { count: 0, bytes: 0 }, unconfirmed: { count: 0, bytes: 0 } } });
        await keeper.remove({ reason: 'notAnimal' });
        assert.deepEqual(store.clipStorage(), { count: 4, bytes: 51, oldestAt: 1_000, byReason: { notAnimal: { count: 0, bytes: 0 }, unconfirmed: { count: 2, bytes: 3 } } });
    });
});

// --- The media budget ---------------------------------------------------------------------------------------------------------------------

test('budget: pruning to a tiny budget removes old photos but never a kept clip, which is not even counted against the budget', async () => {
    await withKeeper(async context => {
        const { store, root, directory, eventsClip } = context;
        // The real layout: the clip store is outside the media directory, so the budget never looks at it.
        const media = join(directory, 'media');
        await mkdir(join(media, 'snap'), { recursive: true });
        await mkdir(join(media, 'clip'), { recursive: true });
        const photo = async (name, size, age) => {
            const file = join(media, 'snap', `${name}.jpg`);
            await writeFile(file, Buffer.alloc(size));
            const at = new Date(Date.now() - age);
            await utimes(file, at, at);
            return file;
        };
        const oldPhoto = await photo('old', 600, 3_000);
        const newPhoto = await photo('new', 600, 1_000);
        await seedKept(context, [{ id: 'kept-outside', at: T0, size: 50_000 }]);
        // The defensive case: a kept clip that sits INSIDE the media directory is exempt as well, and does not count towards the budget.
        store.saveVisit(visit('kept-inside', T0 + 1));
        const inside = join(media, 'clip', 'kept-inside.mp4');
        await writeFile(inside, Buffer.alloc(50_000));
        store.setClip('kept-inside', 'ready', inside, { source: 'nvr', kept: true, bytes: 50_000 });
        // An Events Recorder clip linked from inside the media directory is NOT exempt (it is not Kestrel's copy).
        store.saveVisit(visit('foreign-inside', T0 + 2));
        const foreign = join(media, 'clip', 'foreign-inside.mp4');
        await writeFile(foreign, Buffer.alloc(100));
        store.setClip('foreign-inside', 'ready', foreign, { source: 'events' });

        const result = await store.prune(Date.now(), media, 1_000);
        assert.ok((await stat(inside)).size === 50_000, 'the kept clip inside the media directory survived');
        assert.ok((await stat(join(root, '88', 'kept-outside.mp4'))).size === 50_000, 'and the one in the store');
        assert.equal(store.getVisit('kept-inside').clip.state, 'ready');
        assert.equal(store.getVisit('kept-outside').clip.state, 'ready');
        assert.equal(store.getRawVisit('kept-inside').clip_file, inside);
        await assert.rejects(stat(oldPhoto), 'the oldest photo was pruned to meet the budget');
        await stat(newPhoto);
        assert.ok(result.mediaBytes <= 1_000, `the budget counted ${result.mediaBytes} bytes: the kept clips are not part of it`);
    });
});

// --- Cutting a clip with ffmpeg ------------------------------------------------------------------------------------------------------------

const ffmpegAvailable = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

// 5 s of red followed by 15 s of blue (160 x 120, 25 fps), with a 440 Hz tone when `audio`: a stand-in for "lead-in, then the part that was asked for".
function makeRecording(file, { audio }) {
    const filter = 'color=c=red:s=160x120:d=5:r=25[a];color=c=blue:s=160x120:d=15:r=25[b];[a][b]concat=n=2:v=1:a=0[v]';
    const args = ['-hide_banner', '-loglevel', 'error', '-y',
        ...(audio ? ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=20:sample_rate=16000'] : []),
        '-filter_complex', filter, '-map', '[v]', ...(audio ? ['-map', '0:a'] : []),
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...(audio ? ['-c:a', 'aac'] : []), file];
    const made = spawnSync('ffmpeg', args, { encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);
}

function probe(file) {
    const out = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,codec_type,width,height,r_frame_rate,nb_frames:format=duration,format_name', '-of', 'json', file], { encoding: 'utf8' });
    return JSON.parse(out.stdout);
}

function firstPixel(file) {
    const out = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer' });
    return [...out.stdout];
}

test('cutting: the lead-in the NVR adds before the requested start is trimmed, the result is H.264 mp4 with the index up front', { skip: !ffmpegAvailable }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kestrel-cut-test-'));
    try {
        const recording = join(directory, 'recording.mp4');
        makeRecording(recording, { audio: true });
        // 20 s came back for a 14 s request: the first 6 s are lead-in (the first 5 of them red), the 14 s asked for are blue.
        const destination = join(directory, 'store', '88', 'visit.mp4');
        const outcome = await cutClip({ ffmpegPath: 'ffmpeg', inputArguments: ['-i', recording], durationMs: 14_000, destination });
        assert.equal(outcome.ok, true, JSON.stringify(outcome));
        assert.ok(Math.abs(outcome.leadMs - 6_000) < 150, `lead ${outcome.leadMs}`);
        assert.equal(outcome.audio, true, 'the tone\'s timestamps span the video, so the sound is kept');
        const info = probe(destination);
        assert.ok(Math.abs(Number(info.format.duration) - 14) < 0.3, `duration ${info.format.duration}`);
        const video = info.streams.find(stream => stream.codec_type === 'video');
        assert.equal(video.codec_name, 'h264');
        assert.deepEqual([video.width, video.height], [160, 120]);
        assert.equal(video.r_frame_rate, '25/1', 'the 25 fps of the recording');
        assert.equal(info.streams.find(stream => stream.codec_type === 'audio').codec_name, 'aac');
        const [red, green, blue] = firstPixel(destination);
        assert.ok(blue > 150 && red < 100 && green < 100, `the clip starts in the blue part: rgb(${red}, ${green}, ${blue})`);
        const bytes = await readFile(destination);
        assert.ok(bytes.indexOf('moov') > 0 && bytes.indexOf('moov') < bytes.indexOf('mdat'), 'faststart: the moov index comes before the media data');
        assert.equal(outcome.bytes, bytes.length);
        assert.deepEqual(await readdir(join(directory, 'store', '88')), ['visit.mp4'], 'no scratch or .part file is left');
    } finally { await rm(directory, { recursive: true, force: true }); }
});

// A recording whose timestamps jitter makes ffmpeg read it as 1000 fps (seen on the Backyard camera's NVR recordings); an encode that
// followed that repeated every picture forty times, so the encode is told the measured rate and made constant.
test('the encode uses the frame rate measured from the recording, as a constant rate', () => {
    assert.equal(measuredFps(875, 35_000), 25);
    assert.equal(measuredFps(409, 16_400), 25);
    assert.equal(measuredFps(481, 24_000), 20, 'the Back Door and Front Door cameras run at 20 fps');
    assert.equal(measuredFps(899, 30_000), 30);
    assert.equal(measuredFps(3, 10_000), 10, 'never below 10');
    assert.equal(measuredFps(100_000, 10_000), 60, 'never above 60');
    assert.equal(measuredFps(0, 10_000), 25, 'unknown: 25');
    assert.equal(measuredFps(500, 0), 25);
    const args = encodeArguments({ scratch: '/s/raw.mkv', part: '/s/clip.part', leadMs: 4_280, keepMs: 35_000, fps: 25, audio: false });
    assert.deepEqual(args.slice(args.indexOf('-r'), args.indexOf('-r') + 4), ['-r', '25', '-fps_mode', 'cfr'], 'a constant 25 fps, whatever the file says');
    assert.deepEqual(args.slice(args.indexOf('-ss'), args.indexOf('-ss') + 4), ['-ss', '4.280', '-i', '/s/raw.mkv']);
    assert.equal(args[args.indexOf('-t') + 1], '35.000');
    assert.ok(args.includes('-an') && !args.includes('-c:a'));
    assert.deepEqual(args.slice(args.indexOf('-movflags')), ['-movflags', '+faststart', '-f', 'mp4', '/s/clip.part']);
    const withSound = encodeArguments({ scratch: '/s/raw.mkv', part: '/s/clip.part', leadMs: 0, keepMs: 10_000, fps: 20, audio: true });
    assert.ok(withSound.includes('-c:a') && !withSound.includes('-an'));
    assert.equal(withSound[withSound.indexOf('-r') + 1], '20');
});

test('cutting: a recording that is not 25 fps comes out at its own frame rate', { skip: !ffmpegAvailable }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kestrel-cut-test-'));
    try {
        const recording = join(directory, 'twenty.mkv');
        const made = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=20:duration=20', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', recording], { encoding: 'utf8' });
        assert.equal(made.status, 0, made.stderr);
        const destination = join(directory, 'store', '103', 'twenty.mp4');
        const outcome = await cutClip({ ffmpegPath: 'ffmpeg', inputArguments: ['-i', recording], durationMs: 14_000, destination });
        assert.equal(outcome.ok, true, JSON.stringify(outcome));
        const video = probe(destination).streams.find(stream => stream.codec_type === 'video');
        assert.equal(video.r_frame_rate, '20/1');
        assert.ok(Math.abs(Number(video.nb_frames) - 280) <= 6, `${video.nb_frames} frames for 14 s at 20 fps`);
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test('cutting: a recording without usable sound gives a silent clip, and one that cannot be read gives a failure and leaves nothing behind', { skip: !ffmpegAvailable }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kestrel-cut-test-'));
    try {
        const recording = join(directory, 'recording.mp4');
        makeRecording(recording, { audio: false });
        const destination = join(directory, 'store', '88', 'quiet.mp4');
        const outcome = await cutClip({ ffmpegPath: 'ffmpeg', inputArguments: ['-i', recording], durationMs: 12_000, destination });
        assert.equal(outcome.ok, true, JSON.stringify(outcome));
        assert.equal(outcome.audio, false);
        assert.ok(!probe(destination).streams.some(stream => stream.codec_type === 'audio'));
        assert.ok(Math.abs(Number(probe(destination).format.duration) - 12) < 0.3);

        const missing = join(directory, 'store', '88', 'missing.mp4');
        const failed = await cutClip({ ffmpegPath: 'ffmpeg', inputArguments: ['-i', join(directory, 'no-such-recording.mp4')], durationMs: 12_000, destination: missing });
        assert.equal(failed.ok, false);
        assert.match(failed.reason, /Copying the recording failed/);
        assert.deepEqual((await readdir(join(directory, 'store', '88'))).sort(), ['quiet.mp4']);
        const noFfmpeg = await cutClip({ ffmpegPath: join(directory, 'no-ffmpeg'), inputArguments: ['-i', recording], durationMs: 12_000, destination: missing });
        assert.equal(noFfmpeg.ok, false);
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test('releasing the plugin stops a cut that is still running, and leaves no file behind', { skip: !ffmpegAvailable }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kestrel-cut-test-'));
    try {
        const destination = join(directory, 'store', '88', 'endless.mp4');
        // A test picture that never ends: the copy would run for ever.
        const cutting = cutClip({ ffmpegPath: 'ffmpeg', inputArguments: ['-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=25'], durationMs: 10_000, destination });
        await new Promise(resolve => setTimeout(resolve, 1_500));
        stopRunningCuts();
        const outcome = await Promise.race([cutting, new Promise(resolve => setTimeout(() => resolve('still running'), 15_000))]);
        assert.notEqual(outcome, 'still running', 'the cut ended once its ffmpeg was stopped');
        assert.equal(outcome.ok, false);
        assert.deepEqual(await readdir(join(directory, 'store', '88')), [], 'no scratch file is left');
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test('leftovers of a cut the plugin did not live to finish are removed once they are old, and nothing else is', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kestrel-partials-test-'));
    try {
        await mkdir(join(directory, '88'), { recursive: true });
        const write = async (name, ageMs) => {
            const file = join(directory, '88', name);
            await writeFile(file, 'x');
            const at = new Date(Date.now() - ageMs);
            await utimes(file, at, at);
        };
        await write('stale.mp4.part', 3_600_000);
        await write('stale.mp4.raw.mkv', 3_600_000);
        await write('fresh.mp4.part', 1_000);
        await write('clip.mp4', 3_600_000);
        assert.equal(await removeStalePartials(directory, Date.now()), 2);
        assert.deepEqual((await readdir(join(directory, '88'))).sort(), ['clip.mp4', 'fresh.mp4.part']);
        assert.equal(await removeStalePartials(join(directory, 'missing'), Date.now()), 0);
    } finally { await rm(directory, { recursive: true, force: true }); }
});
