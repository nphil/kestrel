import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ClipKeeper, cutClip, cutGeometry, encodeArguments, isInsideStore, keptClipFile, measuredFps, parseClipDelete, parseOlderThan, removeStalePartials, stopRunningCuts, videoDurationMs } from '../src/clipfiles.ts';
import {
    CLIP_GIVE_UP_MS, CLIP_NVR_AFTER_MS, CLIP_NVR_RETRY_MS, EVENTS_VIDEO_MAX_EXTRA_MS, NVR_ASSUMED_VISIT_MS, NVR_LEAD_MS, NVR_MAX_CLIP_MS, NVR_RETENTION_MARGIN_MS, NVR_TAIL_MS,
    NVR_UNKNOWN_RETENTION_DAYS, ClipResolver, backfillClips, backfillSince, eventsClipStart, nvrClipStart, nvrClipWindow, pollPendingClips,
} from '../src/clips.ts';
import { SameMomentTracker, findEventsRecorderClip, normalizedTime } from '../src/seen.ts';
import { KestrelStore } from '../src/store.ts';
import { visitPayload } from '../src/track.ts';

const DAY = 86_400_000;
const T0 = 1_791_507_668_972;           // the opossum on the Backyard camera, 2026-10-08 21:01:08 EDT
// The Events Recorder's clip of the opossum. Its name says the recording began 555 ms after the visit (the raccoon incident) and lasted
// 19 s. But its ffmpeg starts on the camera's prebuffered stream, so the file holds 20 s of video, and the first frame is where the
// recording stopped minus that: 445 ms BEFORE the visit.
const EVENTS_LAG_MS = 555;
const EVENTS_NAMED_MS = 19_000;
const EVENTS_VIDEO_MS = 20_000;
const NAMED_START = T0 + EVENTS_LAG_MS;
const NAMED_END = NAMED_START + EVENTS_NAMED_MS;
const eventsStartAt = startedAt => startedAt + EVENTS_LAG_MS + EVENTS_NAMED_MS - EVENTS_VIDEO_MS;

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

test('where a cut starts: at the start of its window when the lead-in was skipped, later when the NVR had less footage, earlier when there was too much lead-in to skip', () => {
    const window = nvrClipWindow(T0, T0 + 8_000);           // 5 s before the visit to 10 s after its last detection: 23 s
    assert.deepEqual(window, { start: T0 - 5_000, duration: 23_000 });
    // The stream ends where the window does, so the clip's first frame is `spanMs` before that end.
    const cut = videoMs => { const geometry = cutGeometry(videoMs, window.duration); return { ...geometry, startAt: nvrClipStart(window, geometry.spanMs) }; };
    assert.deepEqual(cut(28_500), { leadMs: 5_500, keepMs: 23_000, spanMs: 23_000, startAt: window.start }, '5.5 s of lead-in, skipped: the clip starts where its window does');
    assert.deepEqual(cut(23_000), { leadMs: 0, keepMs: 23_000, spanMs: 23_000, startAt: window.start }, 'no lead-in at all');
    assert.deepEqual(cut(9_000), { leadMs: 0, keepMs: 9_000, spanMs: 9_000, startAt: window.start + 14_000 }, 'the NVR only had the last 9 s of the window: the clip begins 14 s into it');
    assert.deepEqual(cut(53_000), { leadMs: 30_000, keepMs: 23_000, spanMs: 23_000, startAt: window.start }, 'exactly as much lead-in as can be skipped');
    assert.deepEqual(cut(60_000), { leadMs: 30_000, keepMs: 23_000, spanMs: 30_000, startAt: window.start - 7_000 }, '37 s of lead-in came and only 30 s are skipped: the clip begins 7 s before its window');
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

// --- Finding the Events Recorder's clip, and when it starts ---------------------------------------------------------------------------

// The camera and the folder, faked: `listed` is what the camera lists, `folder` the file names in the folder, `present` the files that exist.
function eventsWorld({ listed = [], folder = [], present = [] } = {}) {
    const asked = [];
    const ports = {
        async videoClips(range) { asked.push(range); return listed; },
        exists: file => present.includes(file),
        async files(directory) { asked.push(directory); return folder; },
    };
    return { asked, ports };
}

const EVENTS_DIR = '/NVR/clips/88/videoclips';
const clipName = (start, end) => `${start}_${end}_1101101000.mp4`;

test('every way the Events Recorder\'s clip is found reports when its recording stopped and how long it says it lasted: a listed clip says it itself', async () => {
    const file = `${EVENTS_DIR}/${clipName(NAMED_START, NAMED_END)}`;
    const { asked, ports } = eventsWorld({ listed: [{ startTime: NAMED_START, duration: EVENTS_NAMED_MS, resources: { video: { file } } }], present: [file] });
    assert.deepEqual(await findEventsRecorderClip(ports, '88', T0), { file, endAt: NAMED_END, spanMs: EVENTS_NAMED_MS });
    assert.deepEqual(asked, [{ startTime: T0 - 90_000, endTime: T0 + 90_000, count: 50 }], 'the camera was asked about the 90 s either side of the visit; the folder was not needed');
    // A camera that gives its times in epoch seconds gives the duration in seconds too: everything is still reported in milliseconds.
    const seconds = Math.floor(NAMED_START / 1000);
    const inSeconds = eventsWorld({ listed: [{ startTime: seconds, duration: 19, resources: { video: { file } } }], present: [file] });
    assert.deepEqual(await findEventsRecorderClip(inSeconds.ports, '88', T0), { file, endAt: (seconds + 19) * 1000, spanMs: 19_000 });
    assert.equal(normalizedTime(1_791_507_669), 1_791_507_669_000);
    assert.equal(normalizedTime(NAMED_START), NAMED_START);
    // A listing without a duration is taken to last a minute, the longest an event is recorded for.
    const open = eventsWorld({ listed: [{ startTime: T0 - 30_000, resources: { video: { file } } }], present: [file] });
    assert.deepEqual(await findEventsRecorderClip(open.ports, '88', T0), { file, endAt: T0 + 30_000, spanMs: 60_000 });
});

test('without a listing the clip comes from the folder: the one that starts closest to the visit, ending at the second number of its name', async () => {
    const wide = clipName(T0 - 30_000, T0 + 10_000);
    const close = clipName(NAMED_START, NAMED_END);
    const folder = [wide, close, clipName(T0 - 600_000, T0 - 580_000), clipName(T0 + 60_000, T0 + 80_000), 'notes.txt', `${NAMED_START}_${NAMED_START + 1}.mp4.part`];
    const { asked, ports } = eventsWorld({ folder, present: [`${EVENTS_DIR}/${wide}`, `${EVENTS_DIR}/${close}`] });
    assert.deepEqual(await findEventsRecorderClip(ports, '88', T0), { file: `${EVENTS_DIR}/${close}`, endAt: NAMED_END, spanMs: EVENTS_NAMED_MS }, 'two clips cover the visit; the one that begins nearest it wins');
    assert.ok(asked.includes(EVENTS_DIR), 'the camera\'s own folder was read');
    const notYet = eventsWorld({ folder, present: [`${EVENTS_DIR}/${wide}`] });
    assert.equal(await findEventsRecorderClip(notYet.ports, '88', T0), undefined, 'the nearest clip is not on disk yet: nothing is linked to a farther one');
    const older = eventsWorld({ folder: [wide], present: [`${EVENTS_DIR}/${wide}`] });
    assert.deepEqual(await findEventsRecorderClip(older.ports, '88', T0), { file: `${EVENTS_DIR}/${wide}`, endAt: T0 + 10_000, spanMs: 40_000 }, 'a clip that began before the visit says when it stopped');
});

test('a listed clip whose file is not there yet gives way to the folder\'s, and a listed clip named without its folder is looked for in it last', async () => {
    const inFolder = clipName(NAMED_START + 40, NAMED_END + 40);
    const listed = [{ startTime: NAMED_START, duration: EVENTS_NAMED_MS, resources: { video: { file: `${EVENTS_DIR}/${clipName(NAMED_START, NAMED_END)}` } } }];
    const world = eventsWorld({ listed, folder: [inFolder], present: [`${EVENTS_DIR}/${inFolder}`] });
    assert.deepEqual(await findEventsRecorderClip(world.ports, '88', T0), { file: `${EVENTS_DIR}/${inFolder}`, endAt: NAMED_END + 40, spanMs: EVENTS_NAMED_MS }, 'the end is the folder file\'s own');
    const bare = eventsWorld({ listed: [{ startTime: NAMED_START, duration: EVENTS_NAMED_MS, resources: { video: { file: 'late.mp4' } } }], present: [`${EVENTS_DIR}/late.mp4`] });
    assert.deepEqual(await findEventsRecorderClip(bare.ports, '88', T0), { file: `${EVENTS_DIR}/late.mp4`, endAt: NAMED_END, spanMs: EVENTS_NAMED_MS });
    const absolute = eventsWorld({ listed: [{ startTime: NAMED_START, duration: EVENTS_NAMED_MS, resources: { video: { file: '/elsewhere/late.mp4' } } }], present: ['/elsewhere/late.mp4'] });
    assert.deepEqual(await findEventsRecorderClip(absolute.ports, '88', T0), { file: '/elsewhere/late.mp4', endAt: NAMED_END, spanMs: EVENTS_NAMED_MS });
});

test('no clip yet: nothing listed, nothing in the folder that covers the visit, a listed clip that stopped before it, or the file is not there', async () => {
    assert.equal(await findEventsRecorderClip(eventsWorld().ports, '88', T0), undefined);
    const lateName = clipName(T0 + 6_000, T0 + 26_000);
    const late = { startTime: T0 + 6_000, duration: 20_000, resources: { video: { file: `${EVENTS_DIR}/${lateName}` } } };
    const world = eventsWorld({ listed: [late], folder: [lateName], present: [`${EVENTS_DIR}/${lateName}`] });
    assert.equal(await findEventsRecorderClip(world.ports, '88', T0), undefined, 'a clip that begins more than 5 s after the visit is another event');
    // A duration is in milliseconds: this clip stopped 41 s before the visit began (read as seconds, it would have covered it for hours).
    const stoppedName = clipName(T0 - 60_000, T0 - 41_000);
    const stopped = { startTime: T0 - 60_000, duration: 19_000, resources: { video: { file: `${EVENTS_DIR}/${stoppedName}` } } };
    assert.equal(await findEventsRecorderClip(eventsWorld({ listed: [stopped], present: [`${EVENTS_DIR}/${stoppedName}`] }).ports, '88', T0), undefined, 'a listed clip that stopped before the visit began does not cover it');
    const gone = { startTime: NAMED_START, duration: EVENTS_NAMED_MS, resources: { video: { file: `${EVENTS_DIR}/${clipName(NAMED_START, NAMED_END)}` } } };
    assert.equal(await findEventsRecorderClip(eventsWorld({ listed: [gone] }).ports, '88', T0), undefined, 'listed, but not on disk');
});

test('the first frame of an Events Recorder clip is where its recording stopped minus the video in the file; the start in its name is off by seconds (measured on real clips)', async () => {
    const startOf = async (name, visitStartedAt, videoMs) => eventsClipStart(await findEventsRecorderClip(eventsWorld({ folder: [name], present: [`${EVENTS_DIR}/${name}`] }).ports, '88', visitStartedAt), videoMs);
    // 18.996 s between the numbers of the name and 19.6 s of video: the first frame is 604 ms before the start the name says.
    assert.equal(await startOf(clipName(1_793_327_225_041, 1_793_327_244_037), 1_793_327_225_100, 19_600), 1_793_327_224_437);
    assert.equal(1_793_327_225_041 - 1_793_327_224_437, 604);
    // 19.398 s between the numbers and 21.6 s of video: the first frame is 2.2 s before the start the name says.
    assert.equal(await startOf(clipName(1_793_327_300_000, 1_793_327_319_398), 1_793_327_300_500, 21_600), 1_793_327_297_798);
    assert.equal(1_793_327_300_000 - 1_793_327_297_798, 2_202);
});

test('a video that cannot be measured, or does not fit its name, gives no start; one that fits gives a whole number of milliseconds', () => {
    const clip = { file: '/f.mp4', endAt: T0 + 20_000, spanMs: 20_000 };
    assert.equal(EVENTS_VIDEO_MAX_EXTRA_MS, 30_000);
    assert.equal(eventsClipStart(clip, 20_000), T0, 'as long as its name says');
    assert.equal(eventsClipStart(clip, 50_000), T0 - 30_000, 'exactly 30 s more than its name says is still believed');
    assert.equal(eventsClipStart(clip, 50_001), null, 'more than that is not');
    assert.equal(eventsClipStart(clip, 10_000), T0 + 10_000, 'exactly half of what its name says is still believed');
    assert.equal(eventsClipStart(clip, 9_999), null, 'less than that is not');
    for (const bad of [0, -1, -20_000, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(eventsClipStart(clip, bad), null, `${bad} ms of video`);
    assert.equal(eventsClipStart({ ...clip, endAt: T0 + 20_000.4 }, 20_000), T0, 'a name in epoch seconds with a fraction does not leave a fraction of a millisecond');
});

// --- The order clips are looked for in -----------------------------------------------------------------------------------------------

// Fake sources that write down every question they are asked, in order (`calls`), and every clip file they are asked to measure
// (`probed`). The Events Recorder's clip is named as in the raccoon incident (the recording began 555 ms after the visit and lasted 19 s)
// and holds `videoMs[file]` of video (20 s unless said otherwise: more than its name says, as real clips do). A cut from the NVR begins
// 5 s before the visit (the lead the plugin asks for).
function fakes({ events = {}, videoMs = {}, records = true, nvr = v => ({ ok: true, file: '/NVR/kestrel/clips/88/cut.mp4', startAt: v.startedAt - NVR_LEAD_MS }) } = {}) {
    const calls = [];
    const probed = [];
    const sources = {
        async events(v) {
            calls.push(`events:${v.id}`);
            return events[v.id] === undefined ? undefined : { file: events[v.id], endAt: v.startedAt + EVENTS_LAG_MS + EVENTS_NAMED_MS, spanMs: EVENTS_NAMED_MS };
        },
        async videoDurationMs(file) {
            probed.push(file);
            const ms = videoMs[file] ?? EVENTS_VIDEO_MS;
            if (ms instanceof Error) throw ms;
            return ms;
        },
        nvrRecords(cameraId) { calls.push(`records:${cameraId}`); return records; },
        async cutNvr(v) {
            calls.push(`nvr:${v.id}`);
            const result = nvr(v);
            if (result instanceof Error) throw result;
            return result;
        },
    };
    return { calls, probed, sources };
}

const pending = (id = 'v1', age = 0, extra = {}) => ({ id, cameraId: '88', startedAt: T0 - age, ...extra });
const resolverAt = (sources, clock, options = {}) => new ClipResolver(sources, { now: () => clock.now, ...options });

test('the Events Recorder is asked first and, when it has the clip, the NVR is never touched', async () => {
    const { calls, probed, sources } = fakes({ events: { v1: '/NVR/clips/88/videoclips/1_2.mp4' } });
    const clock = { now: T0 + CLIP_GIVE_UP_MS + 60_000 };      // even a visit long past its give-up time keeps the Events Recorder's clip
    const overdue = pending('v1', CLIP_GIVE_UP_MS + 60_000);
    const verdict = await resolverAt(sources, clock).resolvePending(overdue);
    assert.deepEqual(verdict, { verdict: 'ready', file: '/NVR/clips/88/videoclips/1_2.mp4', source: 'events', startAt: eventsStartAt(overdue.startedAt) });
    assert.deepEqual(calls, ['events:v1']);
    assert.deepEqual(probed, ['/NVR/clips/88/videoclips/1_2.mp4']);
});

test('an Events Recorder clip is measured once, when it is found, never at the polls of a visit that has no clip yet; a cut from the NVR is not measured at all', async () => {
    const events = {};
    const { probed, sources } = fakes({ events });
    const clock = { now: T0 + 1_000 };
    const resolver = resolverAt(sources, clock);
    for (let poll = 0; poll < 3; poll++) assert.deepEqual(await resolver.resolvePending(pending()), { verdict: 'wait' });
    assert.deepEqual(probed, [], 'no clip, nothing to measure');
    events.v1 = '/NVR/clips/88/videoclips/found.mp4';
    assert.deepEqual(await resolver.resolvePending(pending()), { verdict: 'ready', file: events.v1, source: 'events', startAt: eventsStartAt(T0) });
    assert.deepEqual(probed, [events.v1]);
    assert.ok(eventsStartAt(T0) < T0, 'the first frame is before the visit, although the name says the recording began after it');

    const cut = fakes();
    clock.now = T0 + CLIP_NVR_AFTER_MS;
    assert.deepEqual(await resolverAt(cut.sources, clock).resolvePending(pending()), { verdict: 'ready', file: '/NVR/kestrel/clips/88/cut.mp4', source: 'nvr', startAt: T0 - NVR_LEAD_MS });
    assert.deepEqual(cut.probed, [], 'the start of a cut follows from the window it was cut for');
});

test('an Events Recorder clip whose video cannot be measured or does not fit its name is still ready, with no start and one warning that names the visit; the start in its name is never used instead', async () => {
    const file = '/NVR/clips/88/videoclips/odd.mp4';
    const tooLong = EVENTS_NAMED_MS + EVENTS_VIDEO_MAX_EXTRA_MS + 1;
    const tooShort = EVENTS_NAMED_MS / 2 - 1;
    const cases = [['reads as nothing', 0, 0], ['cannot be measured at all', new Error('no ffmpeg'), 0], ['reads as less than nothing', -3, -3],
        ['holds more than 30 s more than its name says', tooLong, tooLong], ['holds less than half of what its name says', tooShort, tooShort]];
    for (const [why, videoMs, measured] of cases) {
        for (const [path, ask] of [['poll', resolver => resolver.resolvePending(pending())], ['backfill', resolver => resolver.resolveMissing(pending())]]) {
            const warnings = [];
            const { probed, sources } = fakes({ events: { v1: file }, videoMs: { [file]: videoMs } });
            const resolver = resolverAt(sources, { now: T0 + 60_000 }, { onNoStart: (v, clip, ms) => warnings.push([v.id, clip.file, clip.spanMs, ms]) });
            assert.deepEqual(await ask(resolver), { verdict: 'ready', file, source: 'events', startAt: null }, `${why} (${path})`);
            assert.deepEqual(probed, [file], `${why} (${path}): measured once`);
            assert.deepEqual(warnings, [['v1', file, EVENTS_NAMED_MS, measured]], `${why} (${path}): one warning`);
        }
    }
});

test('the NVR is only asked once the visit is overdue, and always after the Events Recorder was asked again', async () => {
    const { calls, probed, sources } = fakes();
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
    assert.deepEqual(verdict, { verdict: 'ready', file: '/NVR/kestrel/clips/88/cut.mp4', source: 'nvr', startAt: T0 - NVR_LEAD_MS });
    assert.deepEqual(calls, ['events:v1', 'records:88', 'nvr:v1'], 'Events Recorder first, then the NVR');
    assert.deepEqual(probed, [], 'a cut from the NVR is not measured');
});

test('a clip the Events Recorder finishes while the NVR is failing still wins', async () => {
    let failing = true;
    const events = {};
    const { calls, sources } = fakes({ events, nvr: v => failing ? { ok: false, reason: 'failed' } : { ok: true, file: '/x', startAt: v.startedAt } });
    const clock = { now: T0 + 100_000 };
    const resolver = resolverAt(sources, clock);
    assert.deepEqual(await resolver.resolvePending(pending()), { verdict: 'wait' });
    events.v1 = '/NVR/clips/88/videoclips/late.mp4';
    clock.now += CLIP_NVR_RETRY_MS + 1;
    assert.deepEqual(await resolver.resolvePending(pending()), { verdict: 'ready', file: '/NVR/clips/88/videoclips/late.mp4', source: 'events', startAt: eventsStartAt(T0) });
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
    assert.deepEqual(await resolverAt(sources, clock).resolvePending(pending()), { verdict: 'ready', file: '/NVR/kestrel/clips/88/cut.mp4', source: 'nvr', startAt: T0 - NVR_LEAD_MS });
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

test('the backfill takes the same two sources in the same order, with no waiting, and measures the Events Recorder\'s clip it finds just as the poll does', async () => {
    const { calls, probed, sources } = fakes({ events: { found: '/NVR/clips/88/videoclips/found.mp4' } });
    const resolver = new ClipResolver(sources);
    assert.deepEqual(await resolver.resolveMissing(pending('found', 2 * DAY)), { verdict: 'ready', file: '/NVR/clips/88/videoclips/found.mp4', source: 'events', startAt: eventsStartAt(T0 - 2 * DAY) });
    assert.deepEqual(calls, ['events:found']);
    assert.deepEqual(probed, ['/NVR/clips/88/videoclips/found.mp4']);
    calls.length = 0;
    assert.deepEqual(await resolver.resolveMissing(pending('cut', 2 * DAY)), { verdict: 'ready', file: '/NVR/kestrel/clips/88/cut.mp4', source: 'nvr', startAt: T0 - 2 * DAY - NVR_LEAD_MS });
    assert.deepEqual(calls, ['events:cut', 'records:88', 'nvr:cut']);
    assert.equal(probed.length, 1, 'a cut from the NVR is not measured');
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
        a: { verdict: 'ready', file: '/s/a.mp4', source: 'nvr', startAt: 10 }, b: { verdict: 'none', reason: 'unavailable' }, c: { verdict: 'ready', file: '/e/c.mp4', source: 'events', startAt: null },
        d: { verdict: 'none', reason: 'no_nvr' }, e: { verdict: 'none', reason: 'failed' }, f: { verdict: 'ready', file: '/s/f.mp4', source: 'nvr', startAt: 60 },
    };
    const asked = [];
    const stored = [];
    const report = await backfillClips({
        candidates: () => rows,
        beyondRetention: () => 7,
        resolve: async v => { asked.push(v.id); if (v.id === 'f') throw new Error('disk full'); return verdicts[v.id]; },
        recovered: async (row, file, source, startAt) => { stored.push([row.id, file, source, startAt]); },
        stopped: () => false,
    });
    assert.deepEqual(asked, ['a', 'b', 'c', 'd', 'e', 'f'], 'in the order given');
    assert.deepEqual(stored, [['a', '/s/a.mp4', 'nvr', 10], ['c', '/e/c.mp4', 'events', null]], 'a clip whose start is unknown is recovered all the same');
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
        await keeper.ready('v1', '88', original, 'events', eventsStartAt(T0));
        const row = store.getRawVisit('v1');
        assert.equal(row.clip_state, 'ready');
        assert.equal(row.clip_file, join(root, '88', 'v1.mp4'));
        assert.equal(row.clip_kept, 1);
        assert.equal(row.clip_bytes, 4321);
        assert.equal(row.clip_source, 'events');
        assert.equal(row.clip_start_at, eventsStartAt(T0), 'the clip says when it starts');
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
        await keeper.ready('v1', '88', original, 'events', eventsStartAt(T0));
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
        await keeper.ready('v1', '88', cut, 'nvr', T0 - NVR_LEAD_MS);
        const row = store.getRawVisit('v1');
        assert.equal(row.clip_file, cut);
        assert.equal(row.clip_kept, 1);
        assert.equal(row.clip_bytes, 777);
        assert.equal(row.clip_source, 'nvr');
        assert.equal(row.clip_start_at, T0 - NVR_LEAD_MS);
        assert.equal(announced[0].clip.source, 'nvr');
    });
});

test('copy-on-ready: when the copy fails the other plugin\'s file stays linked, the failure is reported, and the next sweep copies it', async () => {
    await withKeeper(async ({ store, keeper, root, announced, warnings, eventsClip }) => {
        store.saveVisit(visit('v1', T0, { clip: { state: 'pending', expectedReadyAt: T0 + 45_000 } }));
        const original = await eventsClip('a', 500);
        // A file where the camera folder should be: the copy cannot be made.
        await writeFile(join(root, '88'), 'in the way');
        await keeper.ready('v1', '88', original, 'events', eventsStartAt(T0));
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
        assert.equal(row.clip_start_at, eventsStartAt(T0), 'copying the clip later does not disturb when it starts');
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
function pollerFor({ store, keeper, clock, sources, options = {} }) {
    const resolver = resolverAt(sources, clock, options);
    const nones = [];
    return {
        nones,
        poll: () => pollPendingClips({
            pending: () => store.listPendingClips(clock.now, 100),
            endedAt: () => undefined,
            resolve: v => resolver.resolvePending(v),
            ready: (row, file, source, startAt) => keeper.ready(row.id, row.camera_id, file, source, startAt),
            none: (row, reason) => { nones.push([row.id, reason]); store.setClip(row.id, 'none', null); },
            failed: (row, error) => { throw error; },
            stopped: () => false,
        }),
    };
}

test('a new visit gets the Events Recorder\'s clip when it appears: kept in Kestrel\'s store, source "events", the NVR never asked', async () => {
    await withKeeper(async ({ store, keeper, root, eventsClip, announced }) => {
        store.saveVisit(visit('v1', T0, { clip: { state: 'pending', expectedReadyAt: T0 + 45_000 } }));
        store.appendTrackFrames('v1', [{ t: T0 + 100, boxes: [{ x: 0.45, y: 0.77, w: 0.06, h: 0.13, className: 'animal', score: 0.82 }] }]);
        const events = {};
        const { calls, probed, sources } = fakes({ events });
        const clock = { now: T0 + 1_000 };
        const { poll } = pollerFor({ store, keeper, clock, sources });
        await poll();
        assert.equal(store.getVisit('v1').clip.state, 'pending', 'nothing yet one second in');
        assert.deepEqual(probed, [], 'nothing is measured while there is no clip');
        assert.equal('detections' in visitPayload(store.getVisit('v1'), store), false, 'and no boxes are offered for a clip that is not there');
        events.v1 = await eventsClip('v1', 5000);                  // the Events Recorder finishes its clip
        clock.now = T0 + 20_000;
        await poll();
        const stored = store.getVisit('v1');
        assert.deepEqual(stored.clip, { state: 'ready', expectedReadyAt: T0 + 45_000, url: 'media/clip/v1.mp4', source: 'events' });
        const row = store.getRawVisit('v1');
        assert.equal(row.clip_file, join(root, '88', 'v1.mp4'), 'Kestrel\'s own copy is what the visit serves');
        assert.equal(row.clip_kept, 1);
        assert.equal(row.clip_start_at, eventsStartAt(T0), 'the start worked out from the Events Recorder\'s clip is kept with it');
        assert.equal(visitPayload(store.getVisit('v1'), store).detections.clipStartAt, eventsStartAt(T0), 'and it is what the boxes are drawn from');
        assert.deepEqual(await readFile(row.clip_file), await readFile(events.v1));
        assert.ok(!calls.some(call => call.startsWith('nvr:') || call.startsWith('records:')), 'the NVR was never asked');
        assert.deepEqual(announced.map(v => v.id), ['v1']);
        await poll();
        assert.deepEqual(announced.map(v => v.id), ['v1'], 'and nothing more happens at the next poll');
        assert.deepEqual(probed, [events.v1], 'the clip was measured once, when it was found');
    });
});

test('a new visit the Events Recorder never clips gets an NVR clip once overdue, in the same store, source "nvr"', async () => {
    await withKeeper(async ({ store, keeper, root, announced }) => {
        store.saveVisit(visit('v2', T0, { clip: { state: 'pending', expectedReadyAt: T0 + 45_000 } }));
        const cut = async v => {
            const file = keptClipFile(root, '88', v.id);
            await mkdir(join(root, '88'), { recursive: true });
            await writeFile(file, Buffer.alloc(2048, 3));
            return { ok: true, file, startAt: v.startedAt - NVR_LEAD_MS };
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
        assert.equal(row.clip_start_at, T0 - NVR_LEAD_MS, 'the start of the cut is kept with the clip');
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

test('a new visit whose Events Recorder clip cannot be placed still gets the clip: ready and announced, no start stored, one warning, and no detection boxes in its payload though it has some', async () => {
    await withKeeper(async ({ store, keeper, root, eventsClip, announced }) => {
        store.saveVisit(visit('v1', T0, { clip: { state: 'pending', expectedReadyAt: T0 + 45_000 } }));
        store.appendTrackFrames('v1', [{ t: T0 + 100, boxes: [{ x: 0.45, y: 0.77, w: 0.06, h: 0.13, className: 'animal', score: 0.82 }] }]);
        const events = { v1: await eventsClip('v1', 3000) };
        const { probed, sources } = fakes({ events, videoMs: { [events.v1]: 0 } });
        const noStart = [];
        const { poll } = pollerFor({ store, keeper, clock: { now: T0 + 20_000 }, sources, options: { onNoStart: (v, clip, ms) => noStart.push([v.id, clip.spanMs, ms]) } });
        await poll();
        const row = store.getRawVisit('v1');
        assert.equal(row.clip_state, 'ready');
        assert.equal(row.clip_file, join(root, '88', 'v1.mp4'), 'the clip is kept like any other');
        assert.equal(row.clip_start_at, null);
        assert.equal(store.getVisit('v1').clip.source, 'events');
        assert.deepEqual(announced.map(v => v.id), ['v1']);
        assert.deepEqual(noStart, [['v1', EVENTS_NAMED_MS, 0]]);
        assert.equal(store.getTrack('v1').frames.length, 1, 'the boxes are kept');
        assert.equal('detections' in visitPayload(store.getVisit('v1'), store), false, 'but without a start there is nothing to draw them from');
        await poll();
        assert.deepEqual(probed, [events.v1], 'measured once, not at every poll');
        assert.equal(noStart.length, 1, 'and warned about once');
    });
});

test('the backfill gives a recovered Events Recorder clip its start just as the poll does: worked out when the video fits its name, none when it does not', async () => {
    await withKeeper(async ({ store, keeper, eventsClip }) => {
        store.saveVisit(visit('good', T0));
        store.saveVisit(visit('odd', T0 + 1_000));
        const events = { good: await eventsClip('good', 1200), odd: await eventsClip('odd', 800) };
        const { probed, sources } = fakes({ events, videoMs: { [events.odd]: 0 } });
        const unplaced = [];
        const resolver = new ClipResolver(sources, { onNoStart: v => unplaced.push(v.id) });
        const report = await backfillClips({
            candidates: () => store.listBackfillCandidates(0),
            beyondRetention: () => 0,
            resolve: v => resolver.resolveMissing(v),
            recovered: (row, file, source, startAt) => keeper.ready(row.id, row.camera_id, file, source, startAt),
            stopped: () => false,
        });
        assert.deepEqual(report.recovered, [{ id: 'good', source: 'events' }, { id: 'odd', source: 'events' }]);
        assert.equal(store.getRawVisit('good').clip_start_at, eventsStartAt(T0));
        assert.equal(store.getRawVisit('odd').clip_start_at, null);
        assert.equal(store.getVisit('odd').clip.state, 'ready', 'the clip plays all the same');
        assert.deepEqual(unplaced, ['odd']);
        assert.deepEqual(probed, [events.good, events.odd], 'each clip was measured once');
    });
});

// --- Deleting clips on request ---------------------------------------------------------------------------------------------------------

async function seedKept({ store, keeper, eventsClip }, specs) {
    for (const spec of specs) {
        store.saveVisit(visit(spec.id, spec.at, { status: spec.status ?? 'auto' }), { snapshotFile: `/media/snap/${spec.id}.jpg`, cropFile: `/media/crop/${spec.id}.jpg` });
        store.setClip(spec.id, 'pending', null);
        await keeper.ready(spec.id, '88', await eventsClip(spec.id, spec.size ?? 1000), spec.source ?? 'events', spec.at);
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

// --- Clips of visits nobody confirmed are removed after 90 days --------------------------------------------------------------------------

const RETAIN_NOW = 1_800_000_000_000;
const RETAIN_DAY = 24 * 60 * 60 * 1000;

test('retention: Kestrel\'s copy of the clip of a visit nobody confirmed is deleted once the visit is more than 90 days old, exactly like a delete on request but by "retention"', async () => {
    await withKeeper(async context => {
        const { store, keeper, announced, root } = context;
        await seedKept(context, [
            { id: 'old-auto', at: RETAIN_NOW - 91 * RETAIN_DAY, status: 'auto', size: 10 },
            { id: 'old-learned', at: RETAIN_NOW - 300 * RETAIN_DAY, status: 'learned', size: 20 },
            { id: 'recent', at: RETAIN_NOW - 10 * RETAIN_DAY, status: 'auto', size: 40 },
        ]);
        announced.length = 0;
        assert.deepEqual(await keeper.expireUnconfirmed(), { deleted: 2, freedBytes: 30 });
        for (const id of ['old-auto', 'old-learned']) {
            const stored = store.getVisit(id);
            assert.deepEqual(stored.clip, { state: 'deleted', expectedReadyAt: null, deletedBy: 'retention' });
            assert.equal(stored.species, 'Virginia Opossum', 'the visit itself is kept');
            assert.equal(stored.snapshot, `media/snap/${id}.jpg`, 'and its photos');
            assert.equal(store.getRawVisit(id).clip_file, null);
        }
        assert.equal(store.getVisit('recent').clip.state, 'ready');
        assert.deepEqual(announced.map(v => v.id).sort(), ['old-auto', 'old-learned'], 'one visit_updated per visit');
        assert.ok(announced.every(v => v.clip.deletedBy === 'retention'));
        assert.deepEqual(await readdir(join(root, '88')), ['recent.mp4'], 'only the files of the deleted clips are gone');
    }, { now: () => RETAIN_NOW });
});

test('retention: the cut-off is 90 days to the millisecond, and a visit that is confirmed, corrected, not an animal or can\'t tell keeps its clip however old', async () => {
    await withKeeper(async context => {
        const { store, keeper } = context;
        const ancient = RETAIN_NOW - 500 * RETAIN_DAY;
        const specs = [
            { id: 'just-over', at: RETAIN_NOW - 90 * RETAIN_DAY - 1, status: 'auto', size: 1 },
            { id: 'exactly-90', at: RETAIN_NOW - 90 * RETAIN_DAY, status: 'auto', size: 2 },
            { id: 'just-under', at: RETAIN_NOW - 90 * RETAIN_DAY + 1, status: 'learned', size: 4 },
            { id: 'confirmed', at: ancient, status: 'confirmed', size: 8 },
            { id: 'corrected', at: ancient, status: 'corrected', size: 16 },
            { id: 'not-animal', at: ancient, status: 'not_animal', size: 32 },
            { id: 'cant-tell', at: ancient, status: 'unknown', size: 64 },
        ];
        await seedKept(context, specs);
        assert.deepEqual(await keeper.expireUnconfirmed(), { deleted: 1, freedBytes: 1 });
        assert.deepEqual(specs.map(spec => store.getVisit(spec.id).clip.state), ['deleted', 'ready', 'ready', 'ready', 'ready', 'ready', 'ready']);
    }, { now: () => RETAIN_NOW });
});

test('retention only deletes Kestrel\'s own copies: a clip that is still another plugin\'s file is left alone', async () => {
    await withKeeper(async context => {
        const { store, keeper, eventsClip } = context;
        store.saveVisit(visit('foreign', RETAIN_NOW - 120 * RETAIN_DAY));
        const foreign = await eventsClip('f', 700);
        store.setClip('foreign', 'ready', foreign, { source: 'events' });
        assert.deepEqual(await keeper.expireUnconfirmed(), { deleted: 0, freedBytes: 0 });
        assert.equal(store.getVisit('foreign').clip.state, 'ready');
        assert.equal((await stat(foreign)).size, 700, 'the Events Recorder\'s own file is untouched');
    }, { now: () => RETAIN_NOW });
});

test('retention can run again and again, a visit confirmed in the meantime keeps its clip, and the Settings figure for unconfirmed clips counts exactly what it takes', async () => {
    await withKeeper(async context => {
        const { store, keeper, announced } = context;
        const at = RETAIN_NOW - 100 * RETAIN_DAY;
        await seedKept(context, [{ id: 'a', at, size: 5 }, { id: 'b', at, size: 6 }, { id: 'c', at, size: 7 }]);
        const cutoff = RETAIN_NOW - 90 * RETAIN_DAY;
        assert.deepEqual(store.clipStorage(cutoff).byReason.unconfirmed, { count: 3, bytes: 18 });
        assert.deepEqual(store.clipsUnconfirmedBefore(cutoff).map(row => row.id).sort(), ['a', 'b', 'c']);
        store.saveVisit({ ...store.getVisit('b'), status: 'confirmed' }); // a person confirms 'b' before the night's run
        assert.deepEqual(store.clipStorage(cutoff).byReason.unconfirmed, { count: 2, bytes: 12 });
        announced.length = 0;
        assert.deepEqual(await keeper.expireUnconfirmed(), { deleted: 2, freedBytes: 12 });
        assert.deepEqual(['a', 'b', 'c'].map(id => store.getVisit(id).clip.state), ['deleted', 'ready', 'deleted']);
        assert.equal(store.getVisit('b').status, 'confirmed');
        assert.equal(announced.length, 2);
        assert.deepEqual(await keeper.expireUnconfirmed(), { deleted: 0, freedBytes: 0 }, 'a second run has nothing left to do');
        assert.equal(announced.length, 2, 'and announces nothing');
        assert.deepEqual(store.clipStorage().byReason.unconfirmed, { count: 0, bytes: 0 });
    }, { now: () => RETAIN_NOW });
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
        assert.ok(Math.abs(outcome.spanMs - 14_000) < 150, `span ${outcome.spanMs}`);
        const window = { start: T0 - 5_000, duration: 14_000 };
        assert.ok(Math.abs(nvrClipStart(window, outcome.spanMs) - window.start) < 150, 'the clip starts where the window it was cut for starts');
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

test('cutting: when the NVR had less footage than the window asked for, the clip is as long as the footage and starts later than the window', { skip: !ffmpegAvailable }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kestrel-cut-test-'));
    try {
        const recording = join(directory, 'recording.mp4');
        makeRecording(recording, { audio: false });
        // 20 s came back for a 30 s window: no lead-in at all, and the clip begins 10 s into the window.
        const destination = join(directory, 'store', '88', 'short.mp4');
        const outcome = await cutClip({ ffmpegPath: 'ffmpeg', inputArguments: ['-i', recording], durationMs: 30_000, destination });
        assert.equal(outcome.ok, true, JSON.stringify(outcome));
        assert.equal(outcome.leadMs, 0);
        assert.ok(Math.abs(outcome.spanMs - 20_000) < 150, `span ${outcome.spanMs}`);
        assert.ok(Math.abs(outcome.durationMs - 20_000) < 150, `kept ${outcome.durationMs}`);
        assert.ok(Math.abs(Number(probe(destination).format.duration) - 20) < 0.3);
        const window = { start: T0 - 5_000, duration: 30_000 };
        assert.ok(Math.abs(nvrClipStart(window, outcome.spanMs) - (window.start + 10_000)) < 150, 'the first frame is 10 s after the start of the window');
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test('measuring a clip: the length of its video, and 0 for anything ffmpeg cannot read', { skip: !ffmpegAvailable }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kestrel-measure-test-'));
    try {
        const recording = join(directory, 'recording.mp4');
        makeRecording(recording, { audio: true });             // 20 s of picture and a 20 s tone
        const measured = await videoDurationMs('ffmpeg', recording);
        assert.ok(Math.abs(measured - 20_000) < 150, `measured ${measured} ms`);
        assert.equal(await videoDurationMs('ffmpeg', join(directory, 'missing.mp4')), 0, 'no such file');
        const notVideo = join(directory, 'notes.mp4');
        await writeFile(notVideo, 'this is not a video');
        assert.equal(await videoDurationMs('ffmpeg', notVideo), 0, 'not a video');
        assert.equal(await videoDurationMs(join(directory, 'no-ffmpeg'), recording), 0, 'no ffmpeg to ask');
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
