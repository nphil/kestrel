import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ChangeGate } from '../src/changes.ts';
import { KestrelStore } from '../src/store.ts';

// --- the camera list is announced when it changes, not on a timer -------------------------------

const DAY = 24 * 60 * 60 * 1000;

function camera(id, name, changes = {}) {
    return {
        id, name, nvrCardId: id, online: true, health: 'ok', drops1h: 0, wildlife: true,
        lastDetection: { species: 'Common Raccoon', at: 1790844313703, visitId: 'v1', kind: 'seen', grp: 'mammal' }, ...changes,
    };
}

// What the 30 s check builds: a fresh list of fresh objects every time.
const cameraList = () => [camera('104', 'Front Door Camera'), camera('88', 'Backyard Camera')];

test('the camera list goes out once, and again only when something in it changes', () => {
    const gate = new ChangeGate();
    assert.equal(gate.changed(cameraList()), true, 'the first list always goes out: a restarted plugin cannot know what listeners last saw');
    assert.equal(gate.changed(cameraList()), false, 'the same list rebuilt by the next 30 s check is not news');
    assert.equal(gate.changed(cameraList()), false);

    const changes = {
        'a camera going offline': list => { list[1].online = false; },
        'a camera becoming unstable': list => { list[0].health = 'unstable'; },
        'a dropped connection': list => { list[1].drops1h = 1; },
        'a new latest sighting': list => { list[0].lastDetection = { species: 'Gray Fox', at: 1790844400000, visitId: 'v2', kind: 'seen', grp: 'mammal' }; },
        'the latest sighting changing species': list => { list[0].lastDetection.species = 'Southern Flying Squirrel'; },
        'the latest sighting being heard instead of seen': list => { list[1].lastDetection.kind = 'heard'; },
        'the latest sighting disappearing': list => { list[0].lastDetection = null; },
        'a camera being renamed': list => { list[0].name = 'Porch'; },
        'a camera being added to the wildlife set': list => { list[1].wildlife = false; },
        'a camera appearing': list => { list.push(camera('106', 'Bird Camera')); },
        'a camera disappearing': list => { list.pop(); },
    };
    for (const [what, change] of Object.entries(changes)) {
        const own = new ChangeGate();
        own.changed(cameraList());
        const changed = cameraList();
        change(changed);
        assert.equal(own.changed(changed), true, what);
        const again = cameraList();
        change(again);
        assert.equal(own.changed(again), false, `${what}: and it is said once`);
        assert.equal(own.changed(cameraList()), true, `${what}: going back is a change too`);
    }
});

// --- a removed visit is announced so open dashboards drop it ------------------------------------

const T0 = Date.parse('2026-09-28T06:00:00Z');

function visit(id, kind, species, startedAt, cameraId = '88') {
    return {
        id, camera: { id: cameraId, name: cameraId === '104' ? 'Front Door Camera' : 'Backyard Camera' }, kind, startedAt, species,
        grp: kind === 'heard' ? 'bird' : 'mammal', status: 'auto', score: 0.8, snapshot: null, crop: null,
        clip: { state: 'none', expectedReadyAt: null }, heard: null, audio: null, suggestions: [], firstEver: false, muted: false, notify: false,
    };
}

async function withStore(run) {
    const directory = await mkdtemp(join(tmpdir(), 'kestrel-events-test-'));
    const store = new KestrelStore(join(directory, 'kestrel.sqlite'));
    try { await run(store, directory); }
    finally { store.close(); await rm(directory, { recursive: true, force: true }); }
}

// Records every announcement together with whether the announced rows were still stored at that moment.
function announcements(store) {
    const batches = [];
    store.onVisitsDeleted = ids => batches.push({ ids: [...ids], stillStored: ids.filter(id => store.getVisit(id)) });
    return batches;
}

test('repairing a split visit announces the visit it removed, once, after the row is gone', async () => {
    await withStore(async store => {
        store.saveVisit(visit('keep', 'seen', 'Common Raccoon', T0, '104'));
        store.saveVisit(visit('drop', 'seen', 'Southern Flying Squirrel', T0 + 753, '104'));
        const batches = announcements(store);

        assert.equal(await store.repairSplitSeenVisit('keep', 'drop'), 'merged');
        assert.deepEqual(batches, [{ ids: ['drop'], stillStored: [] }], 'exactly the removed visit, already gone when it was announced');
        assert.ok(store.getVisit('keep'), 'the kept visit is not announced');

        assert.equal(await store.repairSplitSeenVisit('keep', 'drop'), 'absent');
        assert.equal(batches.length, 1, 'repairing again removes nothing, so says nothing');
    });
});

test('a repair that refuses, and a delete of a visit that does not exist, announce nothing', async () => {
    await withStore(async store => {
        store.saveVisit(visit('keep', 'seen', 'Common Raccoon', T0, '104'));
        const corrected = visit('drop', 'seen', 'Southern Flying Squirrel', T0 + 753, '104');
        store.saveVisit(corrected);
        store.recordCorrection(corrected, 'Southern Flying Squirrel', 'Gray Fox', false, null, null);
        const batches = announcements(store);

        assert.equal(await store.repairSplitSeenVisit('keep', 'drop'), 'skipped', 'a person already corrected the visit that would be removed');
        store.deleteVisitRow('never-existed');
        assert.deepEqual(batches, [], 'nothing was removed, so nothing is announced (and never an empty list)');
        assert.ok(store.getVisit('drop'));
    });
});

test('duplicate cleanup announces exactly the rows it removed', async () => {
    await withStore(async store => {
        // One call delivered three times a few milliseconds apart: the first is kept.
        store.saveVisit(visit('jay-1', 'heard', 'Blue Jay', T0));
        store.saveVisit(visit('jay-2', 'heard', 'Blue Jay', T0 + 9));
        store.saveVisit(visit('jay-3', 'heard', 'Blue Jay', T0 + 600));
        // A separate call ten seconds later is a different visit.
        store.saveVisit(visit('jay-4', 'heard', 'Blue Jay', T0 + 10_000));
        // A duplicate that a correction points at is never removed.
        store.saveVisit(visit('hawk-1', 'heard', "Cooper's Hawk", T0 + 60_000));
        const hawk2 = visit('hawk-2', 'heard', "Cooper's Hawk", T0 + 60_000);
        store.saveVisit(hawk2);
        store.recordCorrection(hawk2, "Cooper's Hawk", "Sharp-shinned Hawk", false, null, null);
        const batches = announcements(store);

        const { removed } = store.cleanupDuplicateHeardVisits();
        assert.equal(removed, 2);
        assert.equal(batches.length, 1, 'one announcement for the whole cleanup');
        assert.deepEqual([...batches[0].ids].sort(), ['jay-2', 'jay-3']);
        assert.deepEqual(batches[0].stillStored, [], 'already gone when announced');

        assert.equal(store.cleanupDuplicateHeardVisits().removed, 0);
        assert.equal(batches.length, 1, 'a second run finds nothing and announces nothing');
    });
});

test('regrouping announces the insect calls it drops, not the visits it only reclassifies or protects', async () => {
    await withStore(async store => {
        store.saveVisit(visit('cricket-1', 'heard', 'Cricket', T0));
        const cricket2 = visit('cricket-2', 'heard', 'Cricket', T0 + 1_000);
        store.saveVisit(cricket2);
        store.recordCorrection(cricket2, 'Cricket', 'not_animal', false, null, null);
        store.saveVisit(visit('peeper-1', 'heard', 'Spring Peeper', T0 + 2_000));
        store.saveVisit(visit('owl-1', 'heard', 'Great Horned Owl', T0 + 3_000));
        const batches = announcements(store);

        const { regrouped, dropped } = store.regroupHeardVisits({ cricket: 'drop', 'spring peeper': 'other' });
        assert.deepEqual({ regrouped, dropped }, { regrouped: 1, dropped: 1 });
        assert.deepEqual(batches, [{ ids: ['cricket-1'], stillStored: [] }]);
    });
});

test('the nightly retention prune announces the visits it deletes for being older than three years', async () => {
    await withStore(async (store, directory) => {
        const now = Date.parse('2026-09-28T12:00:00Z');
        store.saveVisit(visit('ancient-1', 'seen', 'Common Raccoon', now - 4 * 365 * DAY));
        store.saveVisit(visit('ancient-2', 'heard', 'Blue Jay', now - 3 * 365 * DAY - DAY));
        store.saveVisit(visit('recent', 'seen', 'Common Raccoon', now - 10 * DAY));
        store.saveVisit(visit('two-years', 'heard', 'Blue Jay', now - 2 * 365 * DAY));
        const batches = announcements(store);

        await store.prune(now, directory, 300 * 1024 * 1024);
        assert.equal(batches.length, 1);
        assert.deepEqual([...batches[0].ids].sort(), ['ancient-1', 'ancient-2']);
        assert.deepEqual(batches[0].stillStored, []);
        assert.ok(store.getVisit('recent') && store.getVisit('two-years'), 'visits inside the retention window stay');

        await store.prune(now, directory, 300 * 1024 * 1024);
        assert.equal(batches.length, 1, 'a second prune has nothing left to delete');
    });
});

test('removals work, and nothing breaks, when nobody is listening', async () => {
    await withStore(async store => {
        store.saveVisit(visit('jay-1', 'heard', 'Blue Jay', T0));
        store.saveVisit(visit('jay-2', 'heard', 'Blue Jay', T0 + 9));
        assert.equal(store.onVisitsDeleted, undefined);
        assert.equal(store.cleanupDuplicateHeardVisits().removed, 1);
        assert.equal(store.getVisit('jay-2'), undefined);
    });
});
