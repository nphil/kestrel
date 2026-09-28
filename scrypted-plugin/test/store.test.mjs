import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { KestrelStore } from '../src/store.ts';

function makeVisit(id, species, score, startedAt) {
    return {
        id,
        camera: { id: '88', name: 'Backyard Camera' },
        kind: 'seen',
        startedAt,
        species,
        grp: 'mammal',
        status: 'auto',
        score,
        snapshot: `media/snap/${id}.jpg`,
        crop: `media/crop/${id}.jpg`,
        clip: { state: 'none', expectedReadyAt: null },
        heard: null,
        audio: null,
        suggestions: [],
        firstEver: true,
        muted: false,
        notify: true,
    };
}

test('undo removes its learning embedding and restores best photos to the correct species', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kestrel-store-test-'));
    const store = new KestrelStore(join(directory, 'kestrel.sqlite'));
    const file = id => join(directory, `${id}.jpg`);
    try {
        const foxOlder = makeVisit('fox-older', 'Fox', 0.8, 1_000);
        const foxTarget = makeVisit('fox-target', 'Fox', 0.9, 2_000);
        const raccoonOther = makeVisit('raccoon-other', 'Raccoon', 0.7, 3_000);
        for (const visit of [foxOlder, foxTarget, raccoonOther]) {
            store.saveVisit(visit, { snapshotFile: file(visit.id), cropFile: file(visit.id) });
            store.considerSpeciesBest(visit, file(visit.id), file(visit.id));
        }
        assert.equal(store.speciesBestPath('Fox'), file('fox-target'));

        const corrected = { ...foxTarget, species: 'Raccoon', status: 'corrected' };
        store.saveVisit(corrected);
        store.refreshSpeciesBestForVisit(corrected.id);
        store.considerSpeciesBest(corrected, file(corrected.id), file(corrected.id));
        const correctionId = store.recordCorrection(corrected, 'Fox', 'Raccoon', false, file(corrected.id), file(corrected.id));
        store.addEmbedding(correctionId, '88', 'Fox', 'Raccoon', Buffer.from([1, 2, 3]));
        assert.equal(store.learningExamples('88', 'Fox').length, 1);
        assert.equal(store.speciesBestPath('Fox'), file('fox-older'));
        assert.equal(store.speciesBestPath('Raccoon'), file('fox-target'));

        store.deleteCorrection(correctionId);
        const restored = { ...corrected, species: 'Fox', status: 'auto' };
        store.saveVisit(restored);
        store.refreshSpeciesBestForVisit(restored.id);
        store.considerSpeciesBest(restored, file(restored.id), file(restored.id));
        assert.equal(store.learningExamples('88', 'Fox').length, 0);
        assert.equal(store.correctionStats().total, 0);
        assert.equal(store.speciesBestPath('Fox'), file('fox-target'));
        assert.equal(store.speciesBestPath('Raccoon'), file('raccoon-other'));
    } finally {
        store.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test('daily camera counters persist and use America/New_York midnight across daylight-saving changes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kestrel-daily-stats-test-'));
    const database = join(directory, 'kestrel.sqlite');
    let store = new KestrelStore(database);
    try {
        const beforeMidnight = Date.parse('2026-09-28T03:59:59Z');
        const afterMidnight = Date.parse('2026-09-28T04:00:00Z');
        store.recordDetectorCheck('88', false, beforeMidnight);
        store.recordDetectorCheck('88', true, beforeMidnight);
        store.recordDetectorCheck('88', false, afterMidnight);
        store.saveVisit(makeVisit('before-midnight', 'Fox', 0.8, beforeMidnight));
        store.saveVisit(makeVisit('after-midnight', 'Raccoon', 0.8, afterMidnight));

        store.saveVisit(makeVisit('spring-day-end', 'Rabbit', 0.7, Date.parse('2026-03-09T03:59:00Z')));
        store.saveVisit(makeVisit('spring-next-day', 'Squirrel', 0.7, Date.parse('2026-03-09T04:30:00Z')));
        store.saveVisit(makeVisit('fall-day-end', 'Deer', 0.7, Date.parse('2026-11-02T04:30:00Z')));
        store.saveVisit(makeVisit('fall-next-day', 'Owl', 0.7, Date.parse('2026-11-02T05:30:00Z')));

        store.close();
        store = new KestrelStore(database);
        assert.deepEqual(store.cameraDailyStats('88', beforeMidnight), { checksToday: 2, emptyChecksToday: 1, visitsToday: 1 });
        assert.deepEqual(store.cameraDailyStats('88', afterMidnight), { checksToday: 1, emptyChecksToday: 0, visitsToday: 1 });
        assert.equal(store.cameraDailyStats('88', Date.parse('2026-03-09T03:59:00Z')).visitsToday, 1);
        assert.equal(store.cameraDailyStats('88', Date.parse('2026-03-09T04:30:00Z')).visitsToday, 1);
        assert.equal(store.cameraDailyStats('88', Date.parse('2026-11-02T04:30:00Z')).visitsToday, 1);
        assert.equal(store.cameraDailyStats('88', Date.parse('2026-11-02T05:30:00Z')).visitsToday, 1);
    } finally {
        store.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test('old daily detector buckets are pruned while the current day remains', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kestrel-daily-prune-test-'));
    const store = new KestrelStore(join(directory, 'kestrel.sqlite'));
    try {
        const oldDay = Date.parse('2026-08-01T12:00:00Z');
        const currentDay = Date.parse('2026-09-15T12:00:00Z');
        store.recordDetectorCheck('88', true, oldDay);
        store.recordDetectorCheck('88', false, currentDay);
        await store.prune(currentDay, directory, 300 * 1024 * 1024);
        assert.equal(store.db.prepare('SELECT checks FROM camera_daily_stats WHERE day=? AND camera_id=?').get('2026-08-01', '88'), undefined);
        assert.equal(store.db.prepare('SELECT checks FROM camera_daily_stats WHERE day=? AND camera_id=?').get('2026-09-15', '88').checks, 1);
    } finally {
        store.close();
        await rm(directory, { recursive: true, force: true });
    }
});
