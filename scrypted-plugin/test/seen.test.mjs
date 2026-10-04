import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { linkSeenAndHeard } from '../src/link.ts';
import { parseLongPollTimeoutMs } from '../src/longpoll.ts';
import { KeyedQueue, SAME_MOMENT_WINDOW_MS, SameMomentTracker, clipCoversVisitStart, decideSeenCommit, mergeSeenDetection, planSeenMerge } from '../src/seen.ts';
import { KestrelStore } from '../src/store.ts';

// --- The raccoon incident (Front Door, 2026-10-01 04:45 EDT), with its real numbers --------------
const T0 = 1790844313703;               // "Common Raccoon" 0.84, first detection
const T1 = 1790844314456;               // "Southern Flying Squirrel" 0.82, 0.753 s later
const CLIP = { start: 1790844314258, end: 1790844330828, file: '/NVR/clips/104/videoclips/1790844314258_1790844330828_1101101000.mp4' };

function seenVisit(id, species, score, startedAt, extra = {}) {
    return {
        id, camera: { id: '104', name: 'Front Door Camera' }, kind: 'seen', startedAt, species, grp: 'mammal', status: 'auto', score,
        snapshot: `media/snap/${id}.jpg`, crop: `media/crop/${id}.jpg`,
        clip: { state: 'pending', expectedReadyAt: startedAt + 45_000 }, heard: null, audio: null, suggestions: [],
        firstEver: true, muted: false, notify: true, ...extra,
    };
}

const incoming = (species, score, startedAt, status = 'auto') => ({ species, score, startedAt, status, detectionLabel: species });
const existing = (species, score, startedAt, extra = {}) => ({ species, score, startedAt, status: 'auto', suggestions: [], ...extra });

async function withStore(run) {
    const directory = await mkdtemp(join(tmpdir(), 'kestrel-seen-test-'));
    const store = new KestrelStore(join(directory, 'kestrel.sqlite'));
    try { await run(store, directory); }
    finally { store.close(); await rm(directory, { recursive: true, force: true }); }
}

// --- A stand-in for main.ts's commit path --------------------------------------------------------
// decideSeenCommit, mergeSeenDetection and linkSeenAndHeard are the functions main.ts calls, so the
// order of the checks and the merge/link rules are tested for real. Only what needs the Scrypted SDK
// is left out (writing the photo files, the clip poller); the event feed is recorded so tests can
// count visit_new and visit_updated.

const COOLDOWN_MS = 10 * 60_000;
const FRONT_DOOR = { id: '104', name: 'Front Door Camera' };
const BACKYARD = { id: '88', name: 'Backyard Camera' };
const H = 1790890000000;                // an arbitrary moment for the heard-versus-seen tests

const detection = (species, score, startedAt, camera = FRONT_DOOR) => ({ species, score, startedAt, camera });

function heardVisit(id, species, startedAt, camera = BACKYARD) {
    return { ...seenVisit(id, species, 0.9, startedAt, { camera }), kind: 'heard', grp: 'bird', snapshot: null, crop: null, clip: { state: 'none', expectedReadyAt: null } };
}

function saveHeard(store, id, species, startedAt, camera = BACKYARD) {
    store.saveVisit(heardVisit(id, species, startedAt, camera), { detectionLabel: species, birdnetDetectionId: 7, birdnetClip: `${id}.wav` });
}

function newCommitter(store, { usual = () => [] } = {}) {
    const tracker = new SameMomentTracker();
    const events = [];
    const ports = { store, tracker, groupFor: () => 'mammal', usualSuggestions: usual, isMuted: () => false };
    let created = 0;
    return {
        tracker,
        events,
        commit({ species, score, startedAt, camera, grp = 'mammal', labelScore = null }) {
            const decision = decideSeenCommit(store, tracker, COOLDOWN_MS, { cameraId: camera.id, startedAt, species });
            if (decision.action === 'skip') return { action: 'skip' };
            if (decision.action === 'merge') {
                const merged = mergeSeenDetection(ports, decision.target, { species, score, labelScore, startedAt, status: 'auto', detectionLabel: species });
                if (merged.changed) events.push(['visit_updated', merged.visit.id]);
                return { action: 'merge', changed: merged.changed, replaceMedia: merged.plan.replaceMedia, visit: store.getVisit(decision.target.id) };
            }
            const id = `visit-${++created}`;
            const visit = seenVisit(id, species, score, startedAt, { camera, grp, labelScore, firstEver: !store.hasSpecies(species) });
            store.saveVisit(visit, { detectionLabel: species, snapshotFile: `/m/snap/${id}.jpg`, cropFile: `/m/crop/${id}.jpg` });
            store.considerSpeciesBest(visit, `/m/snap/${id}.jpg`, `/m/crop/${id}.jpg`);
            tracker.remember(camera.id, id, startedAt);
            linkSeenAndHeard(store, visit, other => events.push(['visit_updated', other.id]));
            events.push(['visit_new', id]);
            return { action: 'create', visit: store.getVisit(id) };
        },
    };
}

// --- planSeenMerge ------------------------------------------------------------------------------

test('the higher-scoring label keeps the species and the other becomes a model suggestion', () => {
    const plan = planSeenMerge(existing('Common Raccoon', 0.84, T0), incoming('Southern Flying Squirrel', 0.82, T1));
    assert.equal(plan.species, 'Common Raccoon');
    assert.equal(plan.speciesChanged, false);
    assert.equal(plan.replaceMedia, false, 'the winning photo is already the visit photo');
    assert.equal(plan.changed, true, 'a new suggestion is a change');
    assert.deepEqual(plan.suggestions, [{ species: 'Southern Flying Squirrel', why: 'model' }]);
});

test('a higher-scoring newcomer takes over the species, score, label and photo; the old species becomes the suggestion', () => {
    const plan = planSeenMerge(
        existing('Southern Flying Squirrel', 0.82, T0, { suggestions: [{ species: 'Common Raccoon', why: 'usual' }, { species: 'Gray Fox', why: 'usual' }] }),
        incoming('Common Raccoon', 0.84, T1, 'learned'));
    assert.equal(plan.species, 'Common Raccoon');
    assert.equal(plan.speciesChanged, true);
    assert.equal(plan.incomingWins, true);
    assert.equal(plan.replaceMedia, true);
    assert.equal(plan.score, 0.84);
    assert.equal(plan.status, 'learned');
    assert.equal(plan.detectionLabel, 'Common Raccoon');
    assert.equal(plan.startedAt, T0, 'the visit keeps the earliest detection as its start');
    assert.deepEqual(plan.suggestions, [{ species: 'Southern Flying Squirrel', why: 'model' }, { species: 'Gray Fox', why: 'usual' }],
        'never suggests the visit\'s own species, even if it used to be a "usual" suggestion');
});

test('equal scores go to the earlier detection', () => {
    const keepsExisting = planSeenMerge(existing('Common Raccoon', 0.8, T0), incoming('Gray Fox', 0.8, T1));
    assert.equal(keepsExisting.species, 'Common Raccoon');
    const earlierIncoming = planSeenMerge(existing('Common Raccoon', 0.8, T1), incoming('Gray Fox', 0.8, T0));
    assert.equal(earlierIncoming.species, 'Gray Fox', 'a detection that finished processing late but happened first wins the tie');
    assert.equal(earlierIncoming.startedAt, T0);
});

test('an unidentified animal never beats a label and is never suggested; a label always beats unidentified', () => {
    const ignored = planSeenMerge(existing('Common Raccoon', 0.5, T0), incoming('Unidentified animal', 0.99, T1));
    assert.equal(ignored.changed, false);
    assert.equal(ignored.species, 'Common Raccoon');
    assert.deepEqual(ignored.suggestions, []);

    const labelled = planSeenMerge(existing('Unidentified animal', 0.9, T0), incoming('Common Raccoon', 0.4, T1));
    assert.equal(labelled.species, 'Common Raccoon');
    assert.equal(labelled.speciesChanged, true);
    assert.deepEqual(labelled.suggestions, [], 'the unidentified placeholder is not offered as a suggestion');
});

test('the same species only upgrades the score and photo when the newcomer is better', () => {
    const better = planSeenMerge(existing('Common Raccoon', 0.7, T0), incoming('Common Raccoon', 0.9, T1));
    assert.equal(better.changed, true);
    assert.equal(better.speciesChanged, false);
    assert.equal(better.replaceMedia, true);
    assert.equal(better.score, 0.9);
    assert.deepEqual(better.suggestions, []);
    const worse = planSeenMerge(existing('Common Raccoon', 0.9, T0), incoming('Common Raccoon', 0.7, T1));
    assert.equal(worse.changed, false);
    assert.equal(worse.score, 0.9);
});

test('a visit a person already corrected or confirmed is left exactly as they decided', () => {
    for (const status of ['corrected', 'confirmed', 'not_animal', 'unknown']) {
        const plan = planSeenMerge(existing('Gray Fox', 0.5, T1, { status, suggestions: [{ species: 'Red Fox', why: 'model' }] }), incoming('Common Raccoon', 0.99, T0));
        assert.equal(plan.changed, false, status);
        assert.equal(plan.species, 'Gray Fox', status);
        assert.equal(plan.startedAt, T1, `${status}: even the start time is untouched`);
        assert.deepEqual(plan.suggestions, [{ species: 'Red Fox', why: 'model' }], status);
    }
});

test('suggestions never duplicate and a repeated loser is not a change', () => {
    const first = planSeenMerge(existing('Common Raccoon', 0.84, T0, { suggestions: [{ species: 'Southern Flying Squirrel', why: 'usual' }] }),
        incoming('Southern Flying Squirrel', 0.8, T1));
    assert.deepEqual(first.suggestions, [{ species: 'Southern Flying Squirrel', why: 'model' }], 'a "usual" suggestion is upgraded to the model\'s real guess');
    const again = planSeenMerge(existing('Common Raccoon', 0.84, T0, { suggestions: first.suggestions }), incoming('Southern Flying Squirrel', 0.79, T1 + 300));
    assert.equal(again.changed, false);
    assert.deepEqual(again.suggestions, first.suggestions);
});

test('an earlier detection that loses still pulls the visit start back, and a missing score ranks last', () => {
    const earlier = planSeenMerge(existing('Common Raccoon', 0.9, T1), incoming('Gray Fox', 0.5, T0));
    assert.equal(earlier.species, 'Common Raccoon');
    assert.equal(earlier.startedAt, T0);
    assert.equal(earlier.changed, true);
    const nullScore = planSeenMerge(existing('Common Raccoon', null, T0), incoming('Gray Fox', 0.1, T1));
    assert.equal(nullScore.species, 'Gray Fox', 'any score beats no score');
});

// --- SameMomentTracker --------------------------------------------------------------------------

test('the same-moment window slides while the animal keeps being detected, but never past the max span', () => {
    const tracker = new SameMomentTracker();
    const maxSpan = 60_000;
    assert.equal(tracker.find('104', T0), undefined);
    tracker.remember('104', 'v1', T0);
    assert.equal(tracker.find('104', T0 + 4_000), 'v1');
    assert.equal(tracker.find('104', T0 + 6_000), undefined, 'beyond the window from the start');
    // A detection every 4 s keeps the visit current well past the initial 5 s window.
    for (let at = T0 + 4_000; at <= T0 + 40_000; at += 4_000) tracker.touch('104', at, maxSpan);
    assert.equal(tracker.find('104', T0 + 43_000), 'v1');
    assert.equal(tracker.find('104', T0 + 46_000), undefined, 'a gap longer than the window ends it');
    // Detections past the max span no longer extend it.
    const bounded = new SameMomentTracker();
    bounded.remember('104', 'v2', T0);
    for (let at = T0 + 4_000; at <= T0 + 100_000; at += 4_000) bounded.touch('104', at, maxSpan);
    assert.equal(bounded.find('104', T0 + 62_000), 'v2');
    assert.equal(bounded.find('104', T0 + 70_000), undefined, 'a stay longer than the max span stops absorbing label flips');
});

test('the tracker is per camera and a newer visit replaces the older one', () => {
    const tracker = new SameMomentTracker();
    tracker.remember('104', 'a', T0);
    tracker.remember('88', 'b', T0);
    assert.equal(tracker.find('104', T0), 'a');
    assert.equal(tracker.find('88', T0), 'b');
    tracker.remember('104', 'c', T0 + 900_000);
    assert.equal(tracker.find('104', T0), undefined);
    assert.equal(tracker.find('104', T0 + 900_000), 'c');
});

test('the per-camera queue runs one task at a time in order, a failure does not block the next, and idle cameras are forgotten', async () => {
    const queue = new KeyedQueue();
    const order = [];
    const slow = queue.run('104', async () => { order.push('slow:start'); await new Promise(resolve => setTimeout(resolve, 30)); order.push('slow:end'); return 'a'; });
    const failing = queue.run('104', async () => { order.push('failing'); throw new Error('boom'); });
    const failingOutcome = failing.then(() => 'resolved', error => error.message);
    const last = queue.run('104', async () => { order.push('last'); return 'c'; });
    const otherCamera = queue.run('88', async () => { order.push('other'); return 'd'; });

    assert.equal(await otherCamera, 'd');
    assert.equal(await slow, 'a');
    assert.equal(await failingOutcome, 'boom');
    assert.equal(await last, 'c', 'a failed task does not block the one queued behind it');
    assert.deepEqual(order.filter(step => step !== 'other'), ['slow:start', 'slow:end', 'failing', 'last'], 'same camera: strictly one after the other, in arrival order');
    assert.ok(order.indexOf('other') < order.indexOf('slow:end'), 'another camera is not held up by a slow one');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(queue.queuedKeys, 0, 'nothing is remembered once a camera is idle');
});

// --- clip start tolerance -----------------------------------------------------------------------

test('a clip that starts after the visit started still covers it (the raccoon incident: +555 ms)', () => {
    assert.ok(CLIP.start > T0, 'the recorder clip begins after the first detection');
    assert.equal(clipCoversVisitStart(CLIP.start, CLIP.end, T0), true);
    assert.equal(clipCoversVisitStart(CLIP.start, CLIP.end, T1), true);
    assert.equal(clipCoversVisitStart(T0 + 5_000, CLIP.end, T0), true, 'exactly at the tolerance');
    assert.equal(clipCoversVisitStart(T0 + 5_001, CLIP.end, T0), false, 'a clip that begins long after is a different event');
    assert.equal(clipCoversVisitStart(T0 - 60_000, T0 - 1, T0), false, 'a clip that ended before the visit does not cover it');
});

// --- events long-poll timeout -------------------------------------------------------------------

test('the events timeout is read as seconds and clamped to 0-25 s; garbage never becomes a hot loop', () => {
    assert.equal(parseLongPollTimeoutMs('25'), 25_000, 'HA asks for 25 (seconds), not 25 ms');
    assert.equal(parseLongPollTimeoutMs('10'), 10_000);
    assert.equal(parseLongPollTimeoutMs('2.5'), 2_500);
    assert.equal(parseLongPollTimeoutMs('0'), 0, 'zero means answer immediately');
    assert.equal(parseLongPollTimeoutMs('-4'), 0);
    assert.equal(parseLongPollTimeoutMs('600'), 25_000, 'clamped to the maximum');
    assert.equal(parseLongPollTimeoutMs(null), 25_000, 'missing parameter waits the full time');
    assert.equal(parseLongPollTimeoutMs(undefined), 25_000);
    assert.equal(parseLongPollTimeoutMs(''), 25_000);
    assert.equal(parseLongPollTimeoutMs('   '), 25_000);
    assert.equal(parseLongPollTimeoutMs('soon'), 25_000, 'unparseable waits the full time instead of returning instantly');
});

// --- the incident, through the real commit path -------------------------------------------------

test('two labels 0.75 s apart on one camera are ONE visit: the higher score wins, one visit_new, the one clip links once', async () => {
    await withStore(async store => {
        const world = newCommitter(store);
        const first = world.commit(detection('Common Raccoon', 0.8403, T0));
        const second = world.commit(detection('Southern Flying Squirrel', 0.8189, T1));

        assert.equal(first.action, 'create');
        assert.equal(second.action, 'merge', 'the cooldown is per species, so only the same-moment check can tell these are one animal');
        assert.equal(second.visit.id, first.visit.id);
        assert.equal(second.visit.species, 'Common Raccoon', 'the higher score keeps the species');
        assert.deepEqual(second.visit.suggestions, [{ species: 'Southern Flying Squirrel', why: 'model' }]);
        assert.equal(store.listVisits({ camera: '104', kind: 'seen' }).items.length, 1, 'one visit, not two');
        assert.deepEqual(world.events.map(([type]) => type), ['visit_new', 'visit_updated'], 'one visit_new; the merge is an update');
        assert.deepEqual(store.speciesList().map(item => item.species), ['Common Raccoon'], 'the squirrel never reaches the life list');

        // The Events Recorder clip starts 555 ms after the first detection; it must still link, once.
        assert.equal(store.listPendingClips(Date.now()).length, 1, 'one visit is waiting for a clip, not two');
        assert.equal(clipCoversVisitStart(CLIP.start, CLIP.end, second.visit.startedAt), true);
        store.setClip(first.visit.id, 'ready', CLIP.file);
        assert.equal(store.getVisit(first.visit.id).clip.state, 'ready');
        assert.equal(store.getRawVisit(first.visit.id).clip_file, CLIP.file);
        assert.equal(store.listPendingClips(Date.now()).length, 0, 'nothing left waiting for a second clip link');
    });
});

test('when the first visit was the lower-scoring label, the better label takes it over cleanly', async () => {
    await withStore(async store => {
        const world = newCommitter(store, { usual: () => [{ species: 'Gray Fox', why: 'usual' }, { species: 'Common Raccoon', why: 'usual' }] });
        const first = world.commit(detection('Southern Flying Squirrel', 0.8189, T0));
        assert.equal(store.db.prepare("SELECT visit_id FROM species_best WHERE species='Southern Flying Squirrel'").get().visit_id, first.visit.id);

        const second = world.commit(detection('Common Raccoon', 0.8403, T1));
        assert.equal(second.action, 'merge');
        const merged = second.visit;
        assert.equal(merged.id, first.visit.id);
        assert.equal(merged.species, 'Common Raccoon');
        assert.equal(merged.score, 0.8403);
        assert.equal(merged.firstEver, true);
        assert.equal(merged.startedAt, T0);
        assert.deepEqual(merged.suggestions, [{ species: 'Southern Flying Squirrel', why: 'model' }, { species: 'Gray Fox', why: 'usual' }]);
        assert.equal(store.getRawVisit(merged.id).detection_label, 'Common Raccoon', 'the stored raw label follows the winner');
        assert.equal(store.db.prepare("SELECT 1 FROM species_best WHERE species='Southern Flying Squirrel'").get(), undefined, 'the old species loses the best-photo entry');
        assert.equal(store.db.prepare("SELECT visit_id FROM species_best WHERE species='Common Raccoon'").get().visit_id, merged.id);
        assert.deepEqual(store.speciesList().map(item => item.species), ['Common Raccoon']);
        assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM corrections').get().n, 0, 'a merge is not a user correction');
        assert.deepEqual(world.events.map(([type]) => type), ['visit_new', 'visit_updated']);
    });
});

test('an animal whose label keeps changing a few seconds apart stays one visit', async () => {
    await withStore(async store => {
        const world = newCommitter(store);
        world.commit(detection('Common Raccoon', 0.84, T0));
        world.commit(detection('Southern Flying Squirrel', 0.82, T0 + 3_000));
        // 7 s after the visit began, but only 4 s after the last report of the same animal.
        const third = world.commit(detection('Gray Fox', 0.7, T0 + 7_000));

        assert.equal(third.action, 'merge');
        assert.equal(store.listVisits({ camera: '104', kind: 'seen' }).items.length, 1);
        assert.deepEqual(third.visit.suggestions.map(item => item.species).sort(), ['Gray Fox', 'Southern Flying Squirrel']);
    });
});

test('a better-scoring report of the same species at the same moment upgrades the visit; a worse one changes nothing', async () => {
    await withStore(async store => {
        const world = newCommitter(store);
        const first = world.commit(detection('Common Raccoon', 0.70, T0));

        // The cooldown alone would call this a repeat of the species and drop it, losing the better photo.
        const better = world.commit(detection('Common Raccoon', 0.91, T0 + 1_500));
        assert.equal(better.action, 'merge');
        assert.equal(better.changed, true);
        assert.equal(better.replaceMedia, true, 'the better detection supplies the photo');
        assert.equal(better.visit.score, 0.91);

        const worse = world.commit(detection('Common Raccoon', 0.50, T0 + 2_500));
        assert.equal(worse.action, 'merge');
        assert.equal(worse.changed, false);
        assert.equal(store.getVisit(first.visit.id).score, 0.91);
        assert.deepEqual(world.events.map(([type]) => type), ['visit_new', 'visit_updated'], 'a report that teaches the visit nothing publishes nothing');
    });
});

test('the same moment is found from the database too, so a plugin restart cannot split a visit', async () => {
    await withStore(async store => {
        const first = newCommitter(store).commit(detection('Common Raccoon', 0.8403, T0));
        const afterRestart = newCommitter(store);      // empty memory, same database
        const second = afterRestart.commit(detection('Southern Flying Squirrel', 0.8189, T1));
        assert.equal(second.action, 'merge');
        assert.equal(second.visit.id, first.visit.id);
    });
});

// --- the per-species cooldown ---------------------------------------------------------------------

test('a genuinely later detection still follows the per-species cooldown', async () => {
    await withStore(async store => {
        const world = newCommitter(store);
        assert.equal(world.commit(detection('Common Raccoon', 0.84, T0)).action, 'create');
        assert.equal(world.commit(detection('Common Raccoon', 0.95, T0 + 2 * 60_000)).action, 'skip', 'the same species again inside the cooldown');
        assert.equal(world.commit(detection('Gray Fox', 0.8, T0 + 2 * 60_000)).action, 'create', 'a different animal, later, is its own visit');
        assert.equal(world.commit(detection('Common Raccoon', 0.8, T0 + 11 * 60_000)).action, 'create', 'after the cooldown it is a new visit');
        assert.equal(store.listVisits({ camera: '104', kind: 'seen' }).items.length, 3);
    });
});

test('a call that was only heard never blocks a sighting of the same species, and the two are linked', async () => {
    await withStore(async store => {
        saveHeard(store, 'heard-jay', 'Blue Jay', H);
        const world = newCommitter(store);

        const seen = world.commit({ ...detection('Blue Jay', 0.93, H + 90_000, BACKYARD), grp: 'bird' });
        assert.equal(seen.action, 'create', 'a Blue Jay heard 90 s ago must not stop the camera recording one it saw');
        assert.equal(seen.visit.kind, 'seen');
        assert.equal(seen.visit.heard.visitId, 'heard-jay');
        assert.equal(seen.visit.heard.hasAudio, true);
        assert.equal(seen.visit.review ?? false, false, 'agreeing species are not a disagreement');
        assert.equal(store.getVisit('heard-jay').kind, 'heard', 'the call keeps its own record');

        assert.equal(world.commit({ ...detection('Blue Jay', 0.9, H + 150_000, BACKYARD), grp: 'bird' }).action, 'skip',
            'once the bird has been SEEN, the cooldown applies to later sightings of it');
    });
});

test('a call heard more than two minutes before the sighting does not block it and is not linked to it', async () => {
    await withStore(async store => {
        saveHeard(store, 'heard-jay', 'Blue Jay', H);
        const seen = newCommitter(store).commit({ ...detection('Blue Jay', 0.93, H + 3 * 60_000, BACKYARD), grp: 'bird' });
        assert.equal(seen.action, 'create');
        assert.equal(seen.visit.heard, null);
    });
});

test('a call heard just after a sighting links to it, and a different species heard nearby sends both to review', async () => {
    await withStore(async store => {
        const world = newCommitter(store);
        const jay = world.commit({ ...detection('Blue Jay', 0.93, H, BACKYARD), grp: 'bird' });

        saveHeard(store, 'heard-jay', 'Blue Jay', H + 40_000);
        const announced = [];
        linkSeenAndHeard(store, store.getVisit('heard-jay'), other => announced.push(other.id));
        assert.equal(store.getVisit(jay.visit.id).heard.visitId, 'heard-jay', 'BirdNET reported it after the camera did');
        assert.deepEqual(announced, [jay.visit.id], 'the sighting is announced as updated');

        const wren = world.commit({ ...detection('Gray Squirrel', 0.8, H + 20 * 60_000, BACKYARD), grp: 'mammal' });
        saveHeard(store, 'heard-wren', 'Carolina Wren', H + 20 * 60_000 + 30_000);
        linkSeenAndHeard(store, store.getVisit('heard-wren'), () => {});
        assert.equal(store.getVisit(wren.visit.id).review, true, 'a sighting and a call that disagree need a person to look');
        assert.equal(store.getVisit('heard-wren').review, true);
        assert.equal(store.getVisit(wren.visit.id).heard, null, 'and they are not linked as the same animal');
    });
});

test('findSeenNear picks the nearest seen visit on that camera inside the window only', async () => {
    await withStore(async store => {
        store.saveVisit(seenVisit('near', 'Common Raccoon', 0.8, T0));
        store.saveVisit(seenVisit('far', 'Gray Fox', 0.8, T0 + 60_000));
        store.saveVisit(seenVisit('other-camera', 'Opossum', 0.8, T0, { camera: { id: '88', name: 'Backyard Camera' } }));
        store.saveVisit({ ...seenVisit('heard-one', 'Carolina Wren', 0.8, T0 + 100), kind: 'heard', snapshot: null, crop: null, clip: { state: 'none', expectedReadyAt: null } });
        assert.equal(store.findSeenNear('104', T0 + 750, SAME_MOMENT_WINDOW_MS)?.id, 'near');
        assert.equal(store.findSeenNear('104', T0 + 5_000, SAME_MOMENT_WINDOW_MS)?.id, 'near', 'inclusive at the window edge');
        assert.equal(store.findSeenNear('104', T0 + 5_001, SAME_MOMENT_WINDOW_MS), undefined, 'a different moment');
        assert.equal(store.findSeenNear('88', T0, SAME_MOMENT_WINDOW_MS)?.id, 'other-camera');
    });
});

// --- the one-time repair of the existing pair ---------------------------------------------------

test('repairSplitSeenVisit folds the squirrel visit into the raccoon one, moves the ready clip, and leaves no trace', async () => {
    await withStore(async (store, directory) => {
        const files = id => ({ snap: join(directory, `${id}.snap.jpg`), crop: join(directory, `${id}.crop.jpg`) });
        const keepFiles = files('keep');
        const dropFiles = files('drop');
        for (const file of [...Object.values(keepFiles), ...Object.values(dropFiles)]) await writeFile(file, 'jpeg');

        const keep = seenVisit('keep', 'Common Raccoon', 0.8403, T0, { clip: { state: 'none', expectedReadyAt: T0 + 45_000 } });
        store.saveVisit(keep, { detectionLabel: 'Common Raccoon', snapshotFile: keepFiles.snap, cropFile: keepFiles.crop });
        store.considerSpeciesBest(keep, keepFiles.snap, keepFiles.crop);
        const drop = seenVisit('drop', 'Southern Flying Squirrel', 0.8189, T1, {
            clip: { state: 'ready', expectedReadyAt: T1 + 45_000 }, suggestions: [{ species: 'Common Raccoon', why: 'usual' }],
        });
        store.saveVisit(drop, { detectionLabel: 'Southern Flying Squirrel', snapshotFile: dropFiles.snap, cropFile: dropFiles.crop, clipFile: CLIP.file });
        store.considerSpeciesBest(drop, dropFiles.snap, dropFiles.crop);

        assert.equal(await store.repairSplitSeenVisit('keep', 'drop'), 'merged');

        const kept = store.getVisit('keep');
        assert.equal(kept.species, 'Common Raccoon');
        assert.equal(kept.score, 0.8403, 'the raccoon keeps its own score');
        assert.equal(kept.clip.state, 'ready');
        assert.equal(kept.clip.url, 'media/clip/keep.mp4', 'media/clip/<kept id>.mp4 now serves the ready clip');
        assert.equal(store.getRawVisit('keep').clip_file, CLIP.file);
        assert.deepEqual(kept.suggestions, [{ species: 'Southern Flying Squirrel', why: 'model' }]);
        assert.equal(kept.firstEver, true);

        assert.equal(store.getVisit('drop'), undefined, 'the squirrel visit is gone');
        assert.deepEqual(store.speciesList().map(item => item.species), ['Common Raccoon'], 'and so is its life-list entry');
        assert.equal(store.db.prepare("SELECT 1 FROM species_best WHERE species='Southern Flying Squirrel' OR visit_id='drop'").get(), undefined);
        assert.equal(store.db.prepare("SELECT visit_id FROM species_best WHERE species='Common Raccoon'").get().visit_id, 'keep');
        assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM corrections').get().n, 0, 'no corrections row');
        await assert.rejects(access(dropFiles.snap), 'the dropped visit\'s photos are deleted');
        await assert.rejects(access(dropFiles.crop));
        await access(keepFiles.snap);
        await access(keepFiles.crop);

        assert.equal(await store.repairSplitSeenVisit('keep', 'drop'), 'absent', 'running it again is a no-op');
    });
});

test('repairSplitSeenVisit refuses a pair it should not touch', async () => {
    await withStore(async store => {
        store.saveVisit(seenVisit('keep', 'Common Raccoon', 0.84, T0));
        store.saveVisit(seenVisit('drop', 'Southern Flying Squirrel', 0.82, T1));
        store.recordCorrection(store.getVisit('drop'), 'Southern Flying Squirrel', 'Gray Fox', false, null, null);
        assert.equal(await store.repairSplitSeenVisit('keep', 'drop'), 'skipped', 'a person already corrected the visit that would be deleted');
        assert.ok(store.getVisit('drop'));
        store.saveVisit(seenVisit('elsewhere', 'Opossum', 0.8, T1, { camera: { id: '88', name: 'Backyard Camera' } }));
        assert.equal(await store.repairSplitSeenVisit('keep', 'elsewhere'), 'skipped', 'different cameras are never the same animal');
    });
});

// --- additive API fields ------------------------------------------------------------------------

test('species rows carry seen/heard counts, last times and last cameras alongside the existing fields', async () => {
    await withStore(async store => {
        const now = Date.now();
        const day = 24 * 60 * 60 * 1000;
        const heard = (id, species, at, camera) => ({ ...seenVisit(id, species, 0.8, at, { camera: { id: camera, name: camera } }), kind: 'heard', grp: 'bird', snapshot: null, crop: null, clip: { state: 'none', expectedReadyAt: null } });
        store.saveVisit(seenVisit('s-old', 'Blue Jay', 0.9, now - 40 * day));                                   // outside 30 d
        store.saveVisit(seenVisit('s-1', 'Blue Jay', 0.9, now - 3 * day));
        store.saveVisit(seenVisit('s-2', 'Blue Jay', 0.9, now - 2 * day, { camera: { id: '88', name: 'Backyard Camera' } }));
        store.saveVisit(heard('h-1', 'Blue Jay', now - 1 * day, '103'));
        store.saveVisit(heard('h-2', 'Blue Jay', now - 5 * day, '88'));
        store.saveVisit(heard('h-only', 'Carolina Wren', now - 10 * 60 * 1000, '106'));

        const jay = store.speciesList().find(item => item.species === 'Blue Jay');
        assert.equal(jay.seenCount30d, 2);
        assert.equal(jay.heardCount30d, 2);
        assert.equal(jay.lastSeenAt, now - 2 * day);
        assert.equal(jay.lastSeenCamera, '88');
        assert.equal(jay.lastHeardAt, now - 1 * day);
        assert.equal(jay.lastHeardCamera, '103');
        assert.equal(jay.count30d, 4, 'the existing combined count is unchanged');
        assert.equal(jay.seen, true);
        assert.equal(jay.heard, true);
        assert.equal(jay.last, now - 1 * day);

        const wren = store.speciesList().find(item => item.species === 'Carolina Wren');
        assert.equal(wren.seenCount30d, 0);
        assert.equal(wren.heardCount30d, 1);
        assert.equal(wren.lastSeenAt, null);
        assert.equal(wren.lastSeenCamera, null);
        assert.equal(wren.lastHeardAt, now - 10 * 60 * 1000);
        assert.equal(wren.lastHeardCamera, '106');
    });
});

// --- The classifier's own confidence (labelScore) ranks detections, not the camera's box score --------
// Real numbers: the saved crop of the Backyard raccoon (box score 0.92) is 99% a raccoon to the classifier; the
// Back Door flying squirrel (box score 0.76) is 64%; a false alarm (box score 0.86) gets no label at all.

test('two detections are ranked by the classifier\'s confidence when both have one, so a higher box score does not win a doubtful label', () => {
    const doubtfulSquirrel = { species: 'Southern Flying Squirrel', score: 0.9, labelScore: 0.64, startedAt: T1, status: 'auto', detectionLabel: 'Southern Flying Squirrel' };
    const keeps = planSeenMerge(existing('Common Raccoon', 0.84, T0, { labelScore: 0.995 }), doubtfulSquirrel);
    assert.equal(keeps.species, 'Common Raccoon');
    assert.equal(keeps.labelScore, 0.995);
    assert.equal(keeps.score, 0.84);
    const takesOver = planSeenMerge(existing('Southern Flying Squirrel', 0.9, T0, { labelScore: 0.64 }),
        { species: 'Common Raccoon', score: 0.84, labelScore: 0.995, startedAt: T1, status: 'auto', detectionLabel: 'Common Raccoon' });
    assert.equal(takesOver.species, 'Common Raccoon');
    assert.equal(takesOver.speciesChanged, true);
    assert.equal(takesOver.score, 0.84);
    assert.equal(takesOver.labelScore, 0.995, 'the visit\'s label score follows the detection that won');
    assert.equal(takesOver.replaceMedia, true);
});

test('label scores and box scores are never mixed: a detection without a label score is compared by box score', () => {
    const older = existing('Common Raccoon', 0.7, T0);
    const withLabel = planSeenMerge(older, { species: 'Common Raccoon', score: 0.6, labelScore: 0.99, startedAt: T1, status: 'auto', detectionLabel: 'Common Raccoon' });
    assert.equal(withLabel.replaceMedia, false, 'the newcomer\'s box score is lower, so its photo does not replace the visit\'s');
    assert.equal(withLabel.score, 0.7);
    assert.equal(withLabel.labelScore, 0.99, 'but the label score the visit lacked is kept');
    assert.equal(withLabel.changed, true);
    const noLabelAgain = planSeenMerge(existing('Common Raccoon', 0.7, T0, { labelScore: 0.9 }), incoming('Common Raccoon', 0.95, T1));
    assert.equal(noLabelAgain.replaceMedia, true, 'only the newcomer has no label score, so the box scores decide');
    assert.equal(noLabelAgain.labelScore, null, 'and the label score belonged to the old photo, which is gone');
});

test('the label score is stored with the visit and follows the winning detection through a merge', async () => {
    await withStore(store => {
        const committer = newCommitter(store);
        const first = committer.commit({ ...detection('Southern Flying Squirrel', 0.9, T0), labelScore: 0.64 });
        assert.equal(first.visit.labelScore, 0.64);
        assert.equal(first.visit.score, 0.9, 'the box score is kept too');
        const second = committer.commit({ ...detection('Common Raccoon', 0.84, T1), labelScore: 0.995 });
        assert.equal(second.action, 'merge');
        assert.equal(second.visit.species, 'Common Raccoon');
        assert.equal(second.visit.labelScore, 0.995);
        assert.equal(second.visit.score, 0.84);
        assert.equal(store.getVisit(first.visit.id).labelScore, 0.995, 'persisted');
        assert.deepEqual(second.visit.suggestions.filter(item => item.why === 'model'), [{ species: 'Southern Flying Squirrel', why: 'model' }]);
    });
});
