import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SameMomentTracker, decideSeenCommit, mergeSeenDetection } from '../src/seen.ts';
import { KestrelStore } from '../src/store.ts';
import { CAMERA_OFFSET_MS, DEFAULT_OFFSET_MS, TRACK_BUFFER_MS, TRACK_MIN_GAP_MS, TRACK_SLACK_MS, TrackRecorder, detectionOffsetMs, normalizeBoxes, visitPayload } from '../src/track.ts';

const T0 = 1_793_327_225_199;           // the animal on the Backyard camera in the NVR's own recording of its detection events

// --- Pixels become shares of the frame --------------------------------------------------------------------------------------------------

const animal = (boundingBox, extra = {}) => ({ className: 'animal', score: 0.82, boundingBox, ...extra });

test('pixel boxes become shares of the picture the detector looked at: 1920x1080, 2560x1920 and the portrait 1920x2560', () => {
    // The Backyard animal from the NVR's own recording: [870, 830, 122, 143] in 1920x1080.
    assert.deepEqual(normalizeBoxes([animal([870, 830, 122, 143], { id: 'w1' })], [1920, 1080]),
        [{ x: 0.453, y: 0.769, w: 0.064, h: 0.132, className: 'animal', score: 0.82, id: 'w1' }]);
    assert.deepEqual(normalizeBoxes([animal([640, 480, 320, 240])], [2560, 1920]), [{ x: 0.25, y: 0.25, w: 0.125, h: 0.125, className: 'animal', score: 0.82 }]);
    // Portrait: 1920 wide and 2560 high, so the box's x counts against 1920 and its y against 2560.
    assert.deepEqual(normalizeBoxes([animal([480, 1280, 96, 512])], [1920, 2560]), [{ x: 0.25, y: 0.5, w: 0.05, h: 0.2, className: 'animal', score: 0.82 }]);
    // Every animal of the event is a box, in the order the detector gave them.
    const both = normalizeBoxes([animal([0, 0, 960, 540], { id: 'w1' }), animal([960, 540, 960, 540], { id: 'w2' })], [1920, 1080]);
    assert.deepEqual(both.map(box => [box.id, box.x, box.y, box.w, box.h]), [['w1', 0, 0, 0.5, 0.5], ['w2', 0.5, 0.5, 0.5, 0.5]]);
    assert.deepEqual(normalizeBoxes([], [1920, 1080]), []);
});

test('positions are rounded to 3 decimals and scores to 2, and only what the event had is kept', () => {
    const [box] = normalizeBoxes([animal([1, 1, 1, 1], { score: 0.8249 })], [3, 3]);
    assert.deepEqual([box.x, box.y, box.w, box.h, box.score], [0.333, 0.333, 0.333, 0.333, 0.82]);
    assert.equal(normalizeBoxes([animal([10, 10, 100, 100], { score: 0.8251 })], [1000, 1000])[0].score, 0.83);

    const [full] = normalizeBoxes([animal([100, 100, 200, 200], { id: 'w7', label: 'Raccoon', labelScore: 0.934, score: 0.7 })], [1000, 1000]);
    assert.deepEqual(full, { x: 0.1, y: 0.1, w: 0.2, h: 0.2, className: 'animal', score: 0.7, id: 'w7', label: 'Raccoon', labelScore: 0.93 });
    // The classifier names an animal only once it is sure, and the NVR almost never passes its confidence on.
    const [bare] = normalizeBoxes([animal([100, 100, 200, 200], { id: 'w7', label: 'Raccoon' })], [1000, 1000]);
    assert.deepEqual(Object.keys(bare), ['x', 'y', 'w', 'h', 'className', 'score', 'id', 'label']);
    // Nothing is invented for what was left out: no id, no label (null or empty), no label score.
    const [plain] = normalizeBoxes([animal([100, 100, 200, 200], { id: '', label: null, labelScore: null })], [1000, 1000]);
    assert.deepEqual(Object.keys(plain), ['x', 'y', 'w', 'h', 'className', 'score']);
    const [noId] = normalizeBoxes([{ className: 'animal', score: 0.5, boundingBox: [100, 100, 200, 200], label: undefined }], [1000, 1000]);
    assert.deepEqual(Object.keys(noId), ['x', 'y', 'w', 'h', 'className', 'score']);
    // A score outside 0..1 is pulled inside.
    assert.deepEqual(normalizeBoxes([animal([1, 1, 2, 2], { score: 1.4, labelScore: -0.2, label: 'x' })], [10, 10]).map(box => [box.score, box.labelScore]), [[1, 0]]);
});

test('a box that sticks out of the frame is cut at its edge, and one with nothing left inside is dropped', () => {
    // Out of the right and bottom edges: [1800, 1000, 240, 160] in 1920x1080 keeps 120 x 80 pixels.
    assert.deepEqual(normalizeBoxes([animal([1800, 1000, 240, 160])], [1920, 1080])[0], { x: 0.938, y: 0.926, w: 0.063, h: 0.074, className: 'animal', score: 0.82 });
    // Out of the left and top edges: [-100, -50, 300, 200] keeps 200 x 150 pixels.
    assert.deepEqual(normalizeBoxes([animal([-100, -50, 300, 200])], [1920, 1080])[0], { x: 0, y: 0, w: 0.104, h: 0.139, className: 'animal', score: 0.82 });
    for (const outside of [[2000, 100, 50, 50], [-200, 10, 100, 50], [10, 1200, 50, 50], [10, -100, 50, 50]])
        assert.deepEqual(normalizeBoxes([animal(outside)], [1920, 1080]), [], `${outside} is outside the frame`);
    // Every number that comes out is a share of the frame.
    for (const box of normalizeBoxes([animal([-5000, -5000, 20000, 20000])], [1920, 1080])) assert.deepEqual([box.x, box.y, box.w, box.h], [0, 0, 1, 1]);
});

test('without the size of the picture a box is believed only when it is already a share of the frame', () => {
    const shares = [0.45, 0.77, 0.06, 0.13];
    for (const dimensions of [undefined, [], [1920], [0, 1080], [1920, 0], [-1920, 1080], [Number.NaN, 1080], ['1920', 1080]]) {
        assert.deepEqual(normalizeBoxes([animal(shares)], dimensions), [{ x: 0.45, y: 0.77, w: 0.06, h: 0.13, className: 'animal', score: 0.82 }], `size ${JSON.stringify(dimensions)}`);
        assert.deepEqual(normalizeBoxes([animal([870, 830, 122, 143])], dimensions), [], `pixels cannot be placed without a size (${JSON.stringify(dimensions)})`);
        assert.deepEqual(normalizeBoxes([animal([0.5, 0.5, 1.5, 0.2])], dimensions), [], 'one number outside 0..1 is enough');
    }
    assert.deepEqual(normalizeBoxes([animal([0.9, 0.9, 0.3, 0.3])], undefined)[0], { x: 0.9, y: 0.9, w: 0.1, h: 0.1, className: 'animal', score: 0.82 }, 'and it is still cut at the edge');
});

test('anything that is not a box with a class and a score is left out, and the good ones next to it are kept', () => {
    const garbage = [
        { className: 'animal', score: 0.8 },                                                   // no box
        animal('870,830,122,143'), animal(null), animal({ x: 1, y: 1, w: 2, h: 2 }),         // not a list of numbers
        animal([1, 2, 3]), animal([1, 2, 3, 4, 5]), animal([]),                              // not four numbers
        animal(['1', '2', '30', '40']), animal([1, 2, Number.NaN, 4]), animal([1, Number.POSITIVE_INFINITY, 3, 4]),
        animal([100, 100, 0, 50]), animal([100, 100, 50, 0]), animal([100, 100, -50, 50]), animal([100, 100, 50, -50]),   // no size
        animal([100, 100, 0.0001, 50]),                                                        // too thin to be seen: 0 once rounded
        { score: 0.8, boundingBox: [100, 100, 50, 50] }, { className: '', score: 0.8, boundingBox: [100, 100, 50, 50] },   // no class
        animal([100, 100, 50, 50], { score: undefined }), animal([100, 100, 50, 50], { score: null }), animal([100, 100, 50, 50], { score: Number.NaN }),
    ];
    assert.deepEqual(normalizeBoxes(garbage, [1920, 1080]), []);
    const good = animal([960, 540, 192, 108], { id: 'w3' });
    assert.deepEqual(normalizeBoxes([...garbage.slice(0, 3), good, ...garbage.slice(3), animal([0, 0, 192, 108], { id: 'w4' })], [1920, 1080]).map(box => box.id), ['w3', 'w4']);
});

// --- Four events a second, per camera --------------------------------------------------------------------------------------------------------

const sample = t => ({ t, boxes: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2, className: 'animal', score: 0.8 }] });

// A store that writes down what it was asked to keep: [visit, times].
function fakeStore() {
    const calls = [];
    return { calls, appendTrackFrames: (visitId, samples) => calls.push([visitId, samples.map(item => item.t)]) };
}

test('a burst of events is thinned to at most four a second per camera: the first, then one every 250 ms or more', () => {
    assert.equal(TRACK_MIN_GAP_MS, 250);
    const store = fakeStore();
    const recorder = new TrackRecorder(store);
    for (let index = 0; index < 20; index++) recorder.observe('88', sample(T0 + index * 50), 'v1');        // 20 events inside one second
    assert.deepEqual(store.calls.map(([, times]) => times), [[T0], [T0 + 250], [T0 + 500], [T0 + 750]]);
    assert.ok(store.calls.length <= 5, 'four or five a second, never more');
    // And over a long stay: 4 a second, whatever the detector's rate.
    store.calls.length = 0;
    for (let index = 0; index < 400; index++) recorder.observe('88', sample(T0 + 10_000 + index * 25), 'v1');    // 40 events a second for 10 s
    assert.equal(store.calls.length, 40);
});

test('an event that is older than the last one kept, or equal to it, is dropped; the next one that is 250 ms later is kept', () => {
    const store = fakeStore();
    const recorder = new TrackRecorder(store);
    for (const t of [T0 + 1_000, T0 + 900, T0 + 1_000, T0 - 5_000, T0 + 1_249, T0 + 1_250, T0 + 1_300, T0 + 1_499, T0 + 1_500]) recorder.observe('88', sample(t), 'v1');
    assert.deepEqual(store.calls.map(([, times]) => times[0]), [T0 + 1_000, T0 + 1_250, T0 + 1_500]);
});

test('every camera has its own throttle, and forgetting a camera (or everything) starts it afresh', () => {
    const store = fakeStore();
    const recorder = new TrackRecorder(store);
    recorder.observe('88', sample(T0), 'a');
    recorder.observe('103', sample(T0), 'b');
    recorder.observe('88', sample(T0 + 100), 'a');                 // too soon on 88
    recorder.observe('103', sample(T0 + 300), 'b');
    assert.deepEqual(store.calls, [['a', [T0]], ['b', [T0]], ['b', [T0 + 300]]]);
    recorder.forget('88');
    recorder.observe('88', sample(T0 - 1_000), 'a');               // would be "older" if camera 88 had not been forgotten
    recorder.observe('103', sample(T0 + 350), 'b');               // 103 was not forgotten: still too soon
    assert.deepEqual(store.calls.slice(3), [['a', [T0 - 1_000]]]);
    recorder.clear();
    recorder.observe('103', sample(T0), 'b');
    assert.deepEqual(store.calls[store.calls.length - 1], ['b', [T0]]);
});

// --- Waiting for the visit ---------------------------------------------------------------------------------------------------------------

test('events that have no visit yet wait in the camera\'s buffer; attaching hands the visit the ones from a moment before its start on, and empties the buffer', () => {
    assert.equal(TRACK_SLACK_MS, 1_000);
    const store = fakeStore();
    const recorder = new TrackRecorder(store);
    for (let index = 0; index < 8; index++) recorder.observe('88', sample(T0 + index * 250));         // T0 ... T0 + 1750, nobody's yet
    recorder.observe('103', sample(T0 + 250));
    assert.deepEqual(store.calls, [], 'nothing reaches the store while there is no visit');
    recorder.attach('88', 'visit-1', T0 + 1_750);
    assert.deepEqual(store.calls, [['visit-1', [T0 + 750, T0 + 1_000, T0 + 1_250, T0 + 1_500, T0 + 1_750]]], 'those from 1 s before the visit\'s start on');
    recorder.attach('88', 'visit-2', T0);
    assert.equal(store.calls.length, 1, 'the buffer was emptied: a second visit does not get the same events again');
    recorder.attach('103', 'visit-3', T0 + 250);
    assert.deepEqual(store.calls[1], ['visit-3', [T0 + 250]], 'another camera\'s buffer was left alone');
    recorder.attach('106', 'visit-4', T0);
    assert.equal(store.calls.length, 2, 'a camera that waited for nothing hands over nothing');
});

test('an attach that finds only events from long before the visit starts hands over nothing, and still empties the buffer', () => {
    const store = fakeStore();
    const recorder = new TrackRecorder(store);
    recorder.observe('88', sample(T0));
    recorder.observe('88', sample(T0 + 300));
    recorder.attach('88', 'visit-1', T0 + 30_000);
    assert.deepEqual(store.calls, []);
    recorder.attach('88', 'visit-1', T0);
    assert.deepEqual(store.calls, [], 'what was thrown away does not come back');
});

test('events that arrive once the visit is known go straight into it and are not kept back; a later one with no visit waits again', () => {
    const store = fakeStore();
    const recorder = new TrackRecorder(store);
    recorder.observe('88', sample(T0));
    recorder.attach('88', 'visit-1', T0);
    recorder.observe('88', sample(T0 + 300), 'visit-1');
    recorder.observe('88', sample(T0 + 600), 'visit-1');
    assert.deepEqual(store.calls, [['visit-1', [T0]], ['visit-1', [T0 + 300]], ['visit-1', [T0 + 600]]]);
    recorder.attach('88', 'visit-2', T0);
    assert.equal(store.calls.length, 3, 'nothing was buffered while the visit was open');
    recorder.observe('88', sample(T0 + 900));
    recorder.attach('88', 'visit-2', T0 + 900);
    assert.deepEqual(store.calls[3], ['visit-2', [T0 + 900]]);
});

test('the buffer keeps one minute (measured from the newest event) and never more than 241 events, however long nobody claims them', () => {
    assert.equal(TRACK_BUFFER_MS, 60_000);
    const store = fakeStore();
    const recorder = new TrackRecorder(store);
    for (let second = 0; second <= 120; second += 10) recorder.observe('88', sample(T0 + second * 1000));
    recorder.attach('88', 'visit-1', Number.NEGATIVE_INFINITY);
    assert.deepEqual(store.calls[0][1], [60, 70, 80, 90, 100, 110, 120].map(second => T0 + second * 1000), 'exactly a minute is still kept, a minute and a bit is not');

    store.calls.length = 0;
    for (let index = 0; index < 10_000; index++) recorder.observe('88', sample(T0 + index * TRACK_MIN_GAP_MS));       // 42 minutes with nobody's visit
    recorder.attach('88', 'visit-2', Number.NEGATIVE_INFINITY);
    assert.equal(store.calls[0][1].length, TRACK_BUFFER_MS / TRACK_MIN_GAP_MS + 1);
    assert.equal(store.calls[0][1][store.calls[0][1].length - 1], T0 + 9_999 * TRACK_MIN_GAP_MS);
});

// --- The commit path, with the real tracker, decision, merge and store ------------------------------------------------------------------------

function seenVisit(id, startedAt, { camera = '88', species = 'Raccoon', clip = { state: 'pending', expectedReadyAt: startedAt + 45_000 } } = {}) {
    return {
        id, camera: { id: camera, name: camera === '88' ? 'Backyard Camera' : 'Back Door Camera' }, kind: 'seen', startedAt, species, grp: 'mammal', status: 'auto', score: 0.8,
        snapshot: `media/snap/${id}.jpg`, crop: `media/crop/${id}.jpg`, clip, heard: null, audio: null, suggestions: [], firstEver: false, muted: false, notify: true,
    };
}

async function withStore(run) {
    const directory = await mkdtemp(join(tmpdir(), 'kestrel-track-test-'));
    const store = new KestrelStore(join(directory, 'kestrel.sqlite'));
    try { await run(store, directory); }
    finally { store.close(); await rm(directory, { recursive: true, force: true }); }
}

const COOLDOWN_MS = 10 * 60_000;

// main.ts's use of the recorder, in main.ts's order: onDetection looks the open visit up BEFORE it touches the tracker; commitDetection
// attaches right after it remembered the new visit; mergeDetection attaches right after the merge taught the tracker the target. The
// decision, the merge and the store are the real ones; only what needs the Scrypted SDK (photos, the classifier) is left out.
function newWorld(store, tracker = new SameMomentTracker()) {
    const recorder = new TrackRecorder(store);
    const ports = { store, tracker, groupFor: () => 'mammal', usualSuggestions: () => [], isMuted: () => false };
    let created = 0;
    return {
        tracker,
        detect(cameraId, t) {
            recorder.observe(cameraId, sample(t), tracker.find(cameraId, t));
            tracker.touch(cameraId, t, COOLDOWN_MS);
        },
        commit({ cameraId = '88', startedAt, species = 'Raccoon' }) {
            const decision = decideSeenCommit(store, tracker, COOLDOWN_MS, { cameraId, startedAt, species });
            if (decision.action === 'skip') return { action: 'skip' };
            if (decision.action === 'merge') {
                mergeSeenDetection(ports, decision.target, { species, score: 0.8, labelScore: null, startedAt, status: 'auto', detectionLabel: species });
                recorder.attach(cameraId, decision.target.id, Math.min(decision.target.startedAt, startedAt));
                return { action: 'merge', id: decision.target.id };
            }
            const id = `visit-${++created}`;
            store.saveVisit(seenVisit(id, startedAt, { camera: cameraId, species }));
            tracker.remember(cameraId, id, startedAt);
            recorder.attach(cameraId, id, startedAt);
            return { action: 'create', id };
        },
    };
}

const times = (store, id) => store.getTrack(id).frames.map(frame => frame.t);

test('a new visit gets the events that waited for it, from a moment before its start; the events after that go straight in', async () => {
    await withStore(store => {
        const world = newWorld(store);
        world.detect('88', T0 - 20_000);                       // another animal, long before
        world.detect('88', T0 - 900);                          // a moment before the visit's own start
        for (const t of [T0, T0 + 300, T0 + 600]) world.detect('88', t);      // the animal, before the classifier has named it
        assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM visit_boxes').get().n, 0, 'no visit yet: nothing is stored');
        const made = world.commit({ startedAt: T0 });
        assert.equal(made.action, 'create');
        assert.deepEqual(times(store, made.id), [T0 - 900, T0, T0 + 300, T0 + 600]);
        for (const t of [T0 + 900, T0 + 1_100, T0 + 1_200]) world.detect('88', t);      // 1100 is within 250 ms of 900: thinned out
        assert.deepEqual(times(store, made.id), [T0 - 900, T0, T0 + 300, T0 + 600, T0 + 900, T0 + 1_200]);
        assert.deepEqual(store.getTrack(made.id).frames[1], sample(T0), 'what was kept is exactly what was observed');
    });
});

test('an animal folded into a visit that already exists (the tracker did not know it) hands that visit the events that waited', async () => {
    await withStore(store => {
        // A visit from before a restart: it is in the database, the tracker has forgotten it.
        store.saveVisit(seenVisit('old-visit', T0 - 2_000));
        const world = newWorld(store);
        for (const t of [T0, T0 + 300]) world.detect('88', t);
        assert.deepEqual(times(store, 'old-visit'), [], 'while the tracker does not know the visit the events wait');
        const merged = world.commit({ startedAt: T0, species: 'Gray Fox' });
        assert.deepEqual(merged, { action: 'merge', id: 'old-visit' });
        assert.deepEqual(times(store, 'old-visit'), [T0, T0 + 300]);
        world.detect('88', T0 + 600);
        assert.deepEqual(times(store, 'old-visit'), [T0, T0 + 300, T0 + 600], 'the merge taught the tracker the visit: events go straight in');
    });
});

test('an animal that is skipped (its species was already seen inside the cooldown) leaves no track, and a visit that starts after its events does not inherit them', async () => {
    await withStore(store => {
        const world = newWorld(store);
        world.detect('88', T0);
        const first = world.commit({ startedAt: T0 });
        assert.deepEqual(times(store, first.id), [T0]);
        // 30 s later another raccoon: out of the 5 s same-moment window, inside the cooldown.
        world.detect('88', T0 + 30_000);
        world.detect('88', T0 + 30_300);
        assert.deepEqual(world.commit({ startedAt: T0 + 30_000 }), { action: 'skip' });
        assert.deepEqual(times(store, first.id), [T0], 'nothing was attached to the visit');
        // 40 s after that a fox arrives: the raccoon's events are still in the buffer, and are not the fox's.
        world.detect('88', T0 + 70_000);
        world.detect('88', T0 + 70_300);
        const fox = world.commit({ startedAt: T0 + 70_000, species: 'Gray Fox' });
        assert.equal(fox.action, 'create');
        assert.deepEqual(times(store, fox.id), [T0 + 70_000, T0 + 70_300]);
    });
});

test('cameras do not share events: a visit on one camera never takes another camera\'s waiting events', async () => {
    await withStore(store => {
        const world = newWorld(store);
        world.detect('103', T0);
        world.detect('88', T0 + 50);
        const made = world.commit({ cameraId: '88', startedAt: T0 + 50 });
        assert.deepEqual(times(store, made.id), [T0 + 50]);
        const other = world.commit({ cameraId: '103', startedAt: T0, species: 'Gray Fox' });
        assert.deepEqual(times(store, other.id), [T0]);
    });
});

// --- The `detections` object of a visit answer --------------------------------------------------------------------------------------------

const REAL_BOX = { x: 0.453, y: 0.769, w: 0.064, h: 0.132, className: 'animal', score: 0.82, id: 'w1', label: 'Virginia Opossum' };

// A store that counts how often a track was asked for.
function trackSource(store) {
    const asked = [];
    return { asked, getTrack: id => { asked.push(id); return store.getTrack(id); } };
}

test('a seen visit with a ready clip, a known clip start and at least one event carries detections: when the clip starts, how far its video lags, the events', async () => {
    await withStore(store => {
        store.saveVisit(seenVisit('v1', T0));
        store.appendTrackFrames('v1', [{ t: T0, boxes: [REAL_BOX] }, { t: T0 + 300, boxes: [{ ...REAL_BOX, x: 0.46 }] }]);
        store.setClip('v1', 'ready', '/NVR/kestrel/clips/88/v1.mp4', { source: 'nvr', startAt: T0 - 5_000 });
        const visit = store.getVisit('v1');
        const payload = visitPayload(visit, store);
        assert.deepEqual(payload.detections, { clipStartAt: T0 - 5_000, offsetMs: -440, frames: [{ t: T0, boxes: [REAL_BOX] }, { t: T0 + 300, boxes: [{ ...REAL_BOX, x: 0.46 }] }] }, 'the default for a cut from the NVR, as nothing was measured');
        assert.deepEqual({ ...payload, detections: undefined }, { ...visit, detections: undefined }, 'everything else of the visit is what it was');
        assert.equal('detections' in visit, false, 'the visit itself was not touched');
        assert.equal('detections' in store.getVisit('v1'), false, 'and a visit read from the store never carries them');
        // Where a sample is in the video: its time, plus the offset, minus the moment the clip starts.
        const [first, second] = payload.detections.frames;
        assert.deepEqual([first, second].map(frame => frame.t + payload.detections.offsetMs - payload.detections.clipStartAt), [5_000 - 440, 5_300 - 440]);
    });
});

test('the default offset is 330 ms for an Events Recorder clip and -440 ms for a cut from the NVR, on every camera, unless a camera has its own number; no source, no offset', () => {
    assert.deepEqual(DEFAULT_OFFSET_MS, { events: 330, nvr: -440 });
    assert.deepEqual(CAMERA_OFFSET_MS, {}, 'no camera needs its own number so far');
    for (const camera of ['88', '103', '104', '106', '999']) {
        assert.equal(detectionOffsetMs(camera, 'events'), 330, `camera ${camera}`);
        assert.equal(detectionOffsetMs(camera, 'nvr'), -440, `camera ${camera}`);
    }
    assert.equal(detectionOffsetMs('88', undefined), 0);
    try {
        CAMERA_OFFSET_MS['88'] = { nvr: -250 };
        CAMERA_OFFSET_MS['103'] = { events: 0 };
        assert.equal(detectionOffsetMs('88', 'nvr'), -250, 'its own number');
        assert.equal(detectionOffsetMs('88', 'events'), 330, 'and the default for the source it has none for');
        assert.equal(detectionOffsetMs('103', 'events'), 0, 'a number of 0 is a number');
        assert.equal(detectionOffsetMs('103', 'nvr'), -440);
        assert.equal(detectionOffsetMs('104', 'nvr'), -440, 'other cameras keep the default');
    } finally {
        for (const key of Object.keys(CAMERA_OFFSET_MS)) delete CAMERA_OFFSET_MS[key];
    }
});

test('the offset in a visit\'s payload is the one measured for its clip, or else the default of its source; a clip from before the source was recorded counts as an Events Recorder clip', async () => {
    await withStore(store => {
        const visitWith = (id, clip, alignment) => {
            store.saveVisit(seenVisit(id, T0));
            store.appendTrackFrames(id, [sample(T0)]);
            store.setClip(id, 'ready', `/clips/${id}.mp4`, { ...clip, startAt: T0 });
            if (alignment !== undefined) store.setClipAlignment(id, alignment, T0 + 60_000);
            return visitPayload(store.getVisit(id), store).detections.offsetMs;
        };
        assert.equal(visitWith('events', { source: 'events' }), 330, 'not looked at yet');
        assert.equal(visitWith('nvr', { source: 'nvr' }), -440);
        assert.equal(visitWith('legacy', {}), 330, 'a clip from before the source was recorded');
        assert.equal(visitWith('events-measured', { source: 'events' }, 210), 210, 'the offset measured for the clip wins');
        assert.equal(visitWith('nvr-measured', { source: 'nvr' }, -980), -980);
        assert.equal(visitWith('measured-zero', { source: 'nvr' }, 0), 0, 'a measured 0 is a measurement, not a missing one');
        assert.equal(visitWith('nothing-clear', { source: 'nvr' }, null), -440, 'looked at, nothing clear in it: the default');
        // A clip that is replaced is a new clip: what was measured for the old one does not carry over.
        store.setClip('nvr-measured', 'ready', '/clips/other.mp4', { source: 'nvr', startAt: T0 - 1_000 });
        assert.equal(visitPayload(store.getVisit('nvr-measured'), store).detections.offsetMs, -440);
        // The measured offset and the start it is measured against come together.
        store.setClipAlignment('nvr-measured', -300, T0);
        assert.deepEqual([visitPayload(store.getVisit('nvr-measured'), store).detections.clipStartAt, visitPayload(store.getVisit('nvr-measured'), store).detections.offsetMs], [T0 - 1_000, -300]);
    });
});

test('no detections unless the clip is ready, its start is known and there is at least one event; heard visits never have any', async () => {
    await withStore(store => {
        const unchanged = id => {
            const visit = store.getVisit(id);
            return visitPayload(visit, store) === visit;
        };
        // A seen visit with one event kept.
        const seed = id => {
            store.saveVisit(seenVisit(id, T0));
            store.appendTrackFrames(id, [sample(T0)]);
        };
        seed('pending');
        seed('none');
        store.setClip('none', 'none', null);
        seed('gone');
        store.setClip('gone', 'ready', '/clips/gone.mp4', { source: 'events', startAt: T0 });
        store.setClip('gone', 'deleted', null);                // the clip is deleted: its track goes with it
        seed('unknown-start');
        store.setClip('unknown-start', 'ready', '/clips/u.mp4', { source: 'events' });         // a clip from before the start was recorded
        store.saveVisit(seenVisit('no-events', T0));
        store.setClip('no-events', 'ready', '/clips/n.mp4', { source: 'events', startAt: T0 });
        store.saveVisit({ ...seenVisit('heard', T0), kind: 'heard', snapshot: null, crop: null, clip: { state: 'none', expectedReadyAt: null } });
        for (const id of ['pending', 'none', 'gone', 'unknown-start', 'no-events', 'heard']) assert.ok(unchanged(id), `${id}: the visit comes back as it is`);
        assert.equal(store.getTrack('unknown-start').frames.length, 1, 'the events of the clip without a known start are kept');
        // The same visit as soon as its start is known.
        store.setClip('unknown-start', 'ready', '/clips/u.mp4', { source: 'events', startAt: T0 - 800 });
        assert.equal(visitPayload(store.getVisit('unknown-start'), store).detections.clipStartAt, T0 - 800);

        // The track is only read for a visit that could carry it.
        const source = trackSource(store);
        for (const id of ['pending', 'none', 'gone', 'no-events', 'heard', 'unknown-start']) visitPayload(store.getVisit(id), source);
        assert.deepEqual(source.asked, ['no-events', 'unknown-start'], 'seen visits with a ready clip only');
    });
});

test('what the visit says of itself is kept in the payload even for a visit with a long track', async () => {
    await withStore(store => {
        store.saveVisit(seenVisit('long', T0));
        store.appendTrackFrames('long', Array.from({ length: 100 }, (_, index) => sample(T0 + index * 250)));
        store.setClip('long', 'ready', '/clips/long.mp4', { source: 'nvr', startAt: T0 - 5_000 });
        const payload = visitPayload(store.getVisit('long'), store);
        assert.equal(payload.detections.frames.length, 100);
        assert.deepEqual(payload.detections.frames.map(frame => frame.t), Array.from({ length: 100 }, (_, index) => T0 + index * 250), 'oldest first');
        assert.equal(payload.clip.source, 'nvr');
        assert.equal(JSON.parse(JSON.stringify(payload)).detections.frames.length, 100, 'and it is plain JSON');
    });
});
