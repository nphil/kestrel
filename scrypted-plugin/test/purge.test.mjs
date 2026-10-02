import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { KestrelStore } from '../src/store.ts';

// Fresh start for heard recordings: everything HEARD before a cutoff goes, nothing else does.

const CUTOFF = Date.parse('2026-10-02T01:53:00Z');

function visit(id, kind, species, startedAt, extra = {}) {
    return {
        id, camera: { id: '88', name: 'Backyard Camera' }, kind, startedAt, species,
        grp: kind === 'heard' ? 'bird' : 'mammal', status: 'auto', score: 0.8, snapshot: null, crop: null,
        clip: { state: 'none', expectedReadyAt: null }, heard: null, audio: null, suggestions: [], firstEver: false, muted: false, notify: false,
        ...extra,
    };
}

async function withStore(run) {
    const directory = await mkdtemp(join(tmpdir(), 'kestrel-purge-test-'));
    const store = new KestrelStore(join(directory, 'kestrel.sqlite'));
    try { await run(store); }
    finally { store.close(); await rm(directory, { recursive: true, force: true }); }
}

const count = (store, sql) => Number(store.db.prepare(sql).get().n);
const ids = store => store.db.prepare('SELECT id FROM visits ORDER BY id').all().map(row => row.id);

function seed(store) {
    store.saveVisit(visit('old-jay', 'heard', 'Blue Jay', CUTOFF - 5000), { birdnetDetectionId: 101 });
    store.saveVisit(visit('old-wren', 'heard', 'Carolina Wren', CUTOFF - 1), { birdnetDetectionId: 102 });
    store.saveVisit(visit('old-nolink', 'heard', 'Blue Jay', CUTOFF - 900));
    store.saveVisit(visit('at-cutoff', 'heard', 'Blue Jay', CUTOFF), { birdnetDetectionId: 103 });
    store.saveVisit(visit('after', 'heard', 'Blue Jay', CUTOFF + 1), { birdnetDetectionId: 104 });
    store.saveVisit(visit('old-raccoon', 'seen', 'Common Raccoon', CUTOFF - 60_000));
}

test('only heard visits that started strictly before the cutoff are removed', async () => {
    await withStore(async store => {
        seed(store);
        const result = store.purgeHeardBefore(CUTOFF, true);
        assert.equal(result.removed, 3);
        assert.deepEqual(result.detectionIds.sort(), [101, 102], 'ids of the removed calls that had a BirdNET-Go detection');
        assert.deepEqual(ids(store), ['after', 'at-cutoff', 'old-raccoon'], 'a call exactly at the cutoff stays; a seen visit older than it stays');
        assert.equal(result.remainingHeard, 2);
    });
});

test('a dry run reports the same numbers and changes nothing', async () => {
    await withStore(async store => {
        seed(store);
        const dry = store.purgeHeardBefore(CUTOFF, false);
        assert.equal(dry.executed, false);
        assert.equal(dry.removed, 3);
        assert.deepEqual(dry.detectionIds.sort(), [101, 102]);
        assert.equal(dry.species, 2);
        assert.equal(dry.remainingHeard, 2);
        assert.equal(count(store, 'SELECT COUNT(*) AS n FROM visits'), 6);
        assert.equal(count(store, 'SELECT COUNT(*) AS n FROM known_species'), 0);
        const real = store.purgeHeardBefore(CUTOFF, true);
        assert.deepEqual({ ...real, executed: false }, dry, 'executing removes exactly what the dry run promised');
    });
});

test('species heard before the cutoff are not "first ever" again afterwards', async () => {
    await withStore(async store => {
        seed(store);
        store.purgeHeardBefore(CUTOFF, true);
        assert.equal(store.hasSpecies('Blue Jay'), true, 'still has a visit anyway');
        assert.equal(store.hasSpecies('Carolina Wren'), true, 'its only visits were purged, yet it is known');
        assert.equal(store.hasSpecies('Wood Thrush'), false, 'a species never recorded is still new');

        // The Wren calls again: its first-ever flag must not come back through a recompute either.
        store.saveVisit(visit('wren-again', 'heard', 'Carolina Wren', CUTOFF + 60_000));
        store.cleanupDuplicateHeardVisits();
        const flag = id => Number(store.db.prepare('SELECT first_ever AS n FROM visits WHERE id=?').get(id).n);
        assert.equal(flag('wren-again'), 0);
        store.saveVisit(visit('thrush', 'heard', 'Wood Thrush', CUTOFF + 120_000));
        store.cleanupDuplicateHeardVisits();
        assert.equal(flag('thrush'), 1, 'a genuinely new species is still flagged');
    });
});

test('a species whose visits were not identifications is not remembered as known', async () => {
    await withStore(async store => {
        store.saveVisit(visit('noise', 'heard', 'Siren', CUTOFF - 10, { status: 'not_animal' }));
        store.purgeHeardBefore(CUTOFF, true);
        assert.equal(store.hasSpecies('Siren'), false);
    });
});

test('corrections and learning embeddings survive; a seen visit loses only its link to a purged call', async () => {
    await withStore(async store => {
        const call = visit('call', 'heard', 'Blue Jay', CUTOFF - 5000);
        store.saveVisit(call);
        const linked = visit('linked', 'seen', 'Blue Jay', CUTOFF - 4000, {
            heard: { visitId: 'call', species: 'Blue Jay', hasAudio: true, birdnetDetectionId: 7, birdnetClip: 'x.wav' },
        });
        store.saveVisit(linked);
        const other = visit('other', 'seen', 'Common Raccoon', CUTOFF - 3000, {
            heard: { visitId: 'kept-call', species: 'Common Raccoon', hasAudio: false, birdnetDetectionId: null, birdnetClip: null },
        });
        store.saveVisit(other);
        store.saveVisit(visit('kept-call', 'heard', 'Common Raccoon', CUTOFF + 5));
        const correctionId = store.recordCorrection(call, 'Blue Jay', 'Steller\'s Jay', false, null, null);
        store.db.prepare('INSERT INTO embeddings(correction_id,camera_id,from_label,to_label,embedding,created_at) VALUES(?,?,?,?,?,?)')
            .run(correctionId, '88', 'Blue Jay', "Steller's Jay", new Uint8Array([1, 2, 3]), 1);

        const result = store.purgeHeardBefore(CUTOFF, true);
        assert.equal(result.removed, 1);
        assert.deepEqual(result.relinked, ['linked']);
        assert.equal(store.getVisit('linked').heard, null);
        assert.equal(store.getVisit('other').heard.visitId, 'kept-call', 'a link to a call that stays is left alone');
        assert.equal(count(store, 'SELECT COUNT(*) AS n FROM corrections'), 1);
        assert.equal(count(store, 'SELECT COUNT(*) AS n FROM embeddings'), 1);
    });
});

test('an empty purge does nothing and a second run finds nothing', async () => {
    await withStore(async store => {
        seed(store);
        assert.equal(store.purgeHeardBefore(CUTOFF - 10 * 24 * 3600_000, true).removed, 0);
        assert.equal(store.purgeHeardBefore(CUTOFF, true).removed, 3);
        const again = store.purgeHeardBefore(CUTOFF, true);
        assert.equal(again.removed, 0);
        assert.deepEqual(again.detectionIds, []);
    });
});
