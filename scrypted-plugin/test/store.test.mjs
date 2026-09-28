import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { KestrelStore } from '../src/store.ts';

function makeVisit(id, species, score, startedAt, cameraId = '88') {
    return {
        id,
        camera: { id: cameraId, name: cameraId === '88' ? 'Backyard Camera' : 'Back Door Camera' },
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

function makeHeardVisit(id, species, startedAt, cameraId = '88') {
    return {
        id,
        camera: { id: cameraId, name: 'Backyard Camera' },
        kind: 'heard',
        startedAt,
        species,
        grp: 'bird',
        status: 'auto',
        score: 0.8,
        snapshot: null,
        crop: null,
        clip: { state: 'none', expectedReadyAt: null },
        heard: null,
        audio: null,
        suggestions: [],
        firstEver: false,
        muted: false,
        notify: false,
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

test('cleanupDuplicateHeardVisits collapses near-duplicate jitter, protects corrected rows, leaves distinct visits alone, and recomputes first_ever', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kestrel-dedup-test-'));
    const store = new KestrelStore(join(directory, 'kestrel.sqlite'));
    try {
        const t0 = Date.parse('2026-09-28T06:00:00Z');
        // Species seen earlier than any heard visit below -- should end up holding first_ever.
        store.saveVisit(makeVisit('seen-owl', 'Great Horned Owl', 0.9, t0));
        // An exact duplicate pair from the (fixed) overlapping-subscription bug: same
        // camera+species+startedAt. No correction on either -- the second (later-inserted) row
        // should be removed, keeping the first.
        store.saveVisit(makeHeardVisit('owl-dup-1', 'Great Horned Owl', t0 + 60_000));
        store.saveVisit(makeHeardVisit('owl-dup-2', 'Great Horned Owl', t0 + 60_000));
        // The real-world case: the two racing deliveries each fell back to Date.now(), landing a
        // few milliseconds apart rather than exactly equal -- must still collapse to one.
        store.saveVisit(makeHeardVisit('jay-dup-1', 'Blue Jay', t0 + 90_000));
        store.saveVisit(makeHeardVisit('jay-dup-2', 'Blue Jay', t0 + 90_009));
        // A third pair, but this time a correction references the row that would normally be
        // removed -- cleanup must never delete a row a correction points at.
        store.saveVisit(makeHeardVisit('hawk-dup-1', "Cooper's Hawk", t0 + 120_000));
        const hawkDup2 = makeHeardVisit('hawk-dup-2', "Cooper's Hawk", t0 + 120_000);
        store.saveVisit(hawkDup2);
        store.recordCorrection(hawkDup2, "Cooper's Hawk", "Sharp-shinned Hawk", false, null, null);
        // Two genuinely separate detections of the same species well outside the jitter window
        // (3 s apart) -- both must survive; the window must not over-merge real repeat calls.
        store.saveVisit(makeHeardVisit('crow-1', 'American Crow', t0 + 180_000));
        store.saveVisit(makeHeardVisit('crow-2', 'American Crow', t0 + 183_000));

        const { removed } = store.cleanupDuplicateHeardVisits();
        assert.equal(removed, 2, 'the two unprotected duplicates (owl, jay) are removed; the corrected hawk row is spared');

        const owlRows = store.db.prepare("SELECT id FROM visits WHERE kind='heard' AND species=?").all('Great Horned Owl');
        assert.deepEqual(owlRows.map(r => r.id), ['owl-dup-1'], 'the first-inserted exact duplicate survives');

        const jayRows = store.db.prepare("SELECT id FROM visits WHERE kind='heard' AND species=?").all('Blue Jay');
        assert.deepEqual(jayRows.map(r => r.id), ['jay-dup-1'], 'the first-inserted near-duplicate (9ms apart) survives');

        const hawkRows = store.db.prepare("SELECT id FROM visits WHERE kind='heard' AND species=? ORDER BY id").all("Cooper's Hawk");
        assert.deepEqual(hawkRows.map(r => r.id).sort(), ['hawk-dup-1', 'hawk-dup-2'], 'both rows survive because one is referenced by a correction');

        const crowRows = store.db.prepare("SELECT id FROM visits WHERE kind='heard' AND species=? ORDER BY id").all('American Crow');
        assert.deepEqual(crowRows.map(r => r.id).sort(), ['crow-1', 'crow-2'], 'visits 3s apart are distinct detections, not jitter, and are both kept');

        const firstEverIds = store.db.prepare('SELECT id FROM visits WHERE first_ever=1 ORDER BY id').all().map(r => r.id);
        assert.deepEqual(firstEverIds.sort(), ['crow-1', 'hawk-dup-1', 'jay-dup-1', 'seen-owl'].sort(),
            'first_ever recomputes per species across kinds -- the earlier seen visit keeps the flag over the later heard duplicate');
    } finally {
        store.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test('regroupHeardVisits reclassifies known non-bird species, drops insects unless corrected, and leaves unknown species alone', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kestrel-regroup-test-'));
    const store = new KestrelStore(join(directory, 'kestrel.sqlite'));
    try {
        const t0 = Date.parse('2026-09-28T06:00:00Z');
        const knownNonBird = { coyote: 'mammal', 'spring peeper': 'other', cricket: 'drop' };

        // Mammal: was wrongly saved as 'bird', should become 'mammal'.
        store.saveVisit(makeHeardVisit('coyote-1', 'Coyote', t0));
        // Amphibian: was wrongly saved as 'bird', should become 'other'.
        store.saveVisit(makeHeardVisit('peeper-1', 'Spring Peeper', t0 + 1000));
        // Insect, uncorrected: should be deleted entirely.
        store.saveVisit(makeHeardVisit('cricket-1', 'Cricket', t0 + 2000));
        // Insect, but a correction references it: must survive, ungrouped (stays 'bird').
        const cricket2 = makeHeardVisit('cricket-2', 'Cricket', t0 + 3000);
        store.saveVisit(cricket2);
        store.recordCorrection(cricket2, 'Cricket', 'not_animal', false, null, null);
        // A real bird, and a species not in the known-non-bird map at all: both left untouched.
        store.saveVisit(makeHeardVisit('owl-1', 'Great Horned Owl', t0 + 4000));
        // A 'seen' visit, unaffected since regroupHeardVisits only touches kind='heard'.
        store.saveVisit(makeVisit('seen-coyote', 'Coyote', 0.9, t0 - 1000));

        const { regrouped, dropped } = store.regroupHeardVisits(knownNonBird);
        assert.equal(regrouped, 2, 'coyote and spring peeper are reclassified');
        assert.equal(dropped, 1, 'only the uncorrected cricket is dropped');

        assert.equal(store.db.prepare("SELECT grp FROM visits WHERE id='coyote-1'").get().grp, 'mammal');
        assert.equal(store.db.prepare("SELECT grp FROM visits WHERE id='peeper-1'").get().grp, 'other');
        assert.equal(store.db.prepare("SELECT grp FROM visits WHERE id='owl-1'").get().grp, 'bird', 'species outside the map is left as-is');
        assert.equal(store.db.prepare("SELECT grp FROM visits WHERE id='seen-coyote'").get().grp, 'mammal', 'seen visits are untouched by this heard-only migration');

        assert.equal(store.db.prepare("SELECT 1 FROM visits WHERE id='cricket-1'").get(), undefined, 'the uncorrected insect row is deleted');
        const survivingCricket = store.db.prepare("SELECT grp FROM visits WHERE id='cricket-2'").get();
        assert.ok(survivingCricket, 'the corrected insect row survives because a correction references it');
        assert.equal(survivingCricket.grp, 'bird', 'a protected drop-candidate is left ungrouped rather than silently reclassified');
    } finally {
        store.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test('usualSpeciesAtCamera ranks by count within the window, excludes the given species and non-identifications, and stays per-camera', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kestrel-usual-test-'));
    const store = new KestrelStore(join(directory, 'kestrel.sqlite'));
    try {
        const now = Date.parse('2026-09-28T12:00:00Z');
        const windowMs = 30 * 24 * 60 * 60 * 1000;
        const within = (daysAgo) => now - daysAgo * 24 * 60 * 60 * 1000;
        let n = 0;
        const seen = (species, daysAgo, camera = '88') => store.saveVisit(makeVisit(`v${n++}`, species, 0.8, within(daysAgo), camera));
        const heard = (species, daysAgo, camera = '88') => store.saveVisit(makeHeardVisit(`h${n++}`, species, within(daysAgo), camera));

        // Robin: 3 sightings (seen+heard mixed) -- should rank first.
        seen('American Robin', 1); heard('American Robin', 2); seen('American Robin', 5);
        // Jay: 2 sightings -- second place.
        seen('Blue Jay', 3); heard('Blue Jay', 10);
        // Wren and Crow: 1 sighting each -- tied for third, alphabetical tiebreak (Crow before Wren).
        seen('Carolina Wren', 15);
        seen('American Crow', 20);
        // Excluded: not_animal/unknown status, and the literal "Unidentified animal" species, even
        // though they would otherwise be frequent enough to rank.
        const notAnimal = makeVisit('excl-1', 'Squirrel', 0.9, within(1), '88'); notAnimal.status = 'not_animal';
        store.saveVisit(notAnimal);
        const unknownStatus = makeVisit('excl-2', 'Fox', 0.9, within(1), '88'); unknownStatus.status = 'unknown';
        store.saveVisit(unknownStatus);
        seen('Unidentified animal', 1);
        // Outside the 30-day window -- must not count.
        seen('Great Horned Owl', 45);
        // A different camera entirely -- must not leak in.
        seen('Northern Cardinal', 1, '103');

        const usual = store.usualSpeciesAtCamera('88', 'American Robin', now - windowMs, 5);
        assert.deepEqual(usual, ['Blue Jay', 'American Crow', 'Carolina Wren'],
            'own species excluded; ranked by count then alphabetically; window/status/other-camera exclusions applied');

        const limited = store.usualSpeciesAtCamera('88', 'zzz-nonexistent', now - windowMs, 2);
        assert.deepEqual(limited, ['American Robin', 'Blue Jay'], 'limit is respected');
    } finally {
        store.close();
        await rm(directory, { recursive: true, force: true });
    }
});
