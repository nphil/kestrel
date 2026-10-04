import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { KestrelStore } from '../src/store.ts';
import { DatabaseSync } from 'node:sqlite';

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

test('usualSpeciesAtCamera suggests only birds a person confirmed (or corrected a visit to) at this camera, most often first', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kestrel-usual-test-'));
    const store = new KestrelStore(join(directory, 'kestrel.sqlite'));
    try {
        const now = Date.parse('2026-09-28T12:00:00Z');
        const windowMs = 90 * 24 * 60 * 60 * 1000;
        const within = (daysAgo) => now - daysAgo * 24 * 60 * 60 * 1000;
        let n = 0;
        const visit = (species, daysAgo, status = 'confirmed', camera = '88') => store.saveVisit({ ...makeHeardVisit(`h${n++}`, species, within(daysAgo), camera), status });
        const seen = (species, daysAgo, status = 'confirmed') => store.saveVisit({ ...makeVisit(`s${n++}`, species, 0.8, within(daysAgo)), status });

        // Robin: 3 verified visits (a sighting and two calls) -- ranks first, but it is the visit's own species.
        seen('American Robin', 1); visit('American Robin', 2, 'corrected'); visit('American Robin', 5);
        // Jay: 2. Wren and Crow: 1 each, tied, so alphabetical (Crow before Wren).
        visit('Blue Jay', 3); seen('Blue Jay', 10);
        visit('Carolina Wren', 15);
        visit('American Crow', 20);
        // What a model said and nobody checked is never a suggestion, however often it said it.
        for (let i = 0; i < 6; i++) visit('Great Horned Owl', 1 + i, 'auto');
        // Not an animal / can't tell are not birds, and the placeholder is not a species.
        visit('Squirrel', 1, 'not_animal'); visit('Fox', 1, 'unknown'); visit('Unidentified animal', 1, 'confirmed');
        // Outside the window, and another camera, do not count.
        visit('Wood Thrush', 100);
        visit('Northern Cardinal', 1, 'confirmed', '103');

        assert.deepEqual(store.usualSpeciesAtCamera('88', 'American Robin', now - windowMs, 5), ['Blue Jay', 'American Crow', 'Carolina Wren']);
        assert.deepEqual(store.usualSpeciesAtCamera('88', 'zzz-nonexistent', now - windowMs, 2), ['American Robin', 'Blue Jay'], 'the limit is respected');
        assert.deepEqual(store.usualSpeciesAtCamera('103', 'zzz-nonexistent', now - windowMs, 5), ['Northern Cardinal'], 'and it stays per camera');
    } finally {
        store.close();
        await rm(directory, { recursive: true, force: true });
    }
});

function ratedHeardVisit(id, species, startedAt, tier, status = 'auto') {
    return { ...makeHeardVisit(id, species, startedAt), tier, status, firstEver: false };
}

test('a heard call that is only Possible or Check does not count toward the species list or "first ever" until a person confirms or corrects it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kestrel-counts-test-'));
    const store = new KestrelStore(join(directory, 'kestrel.sqlite'));
    try {
        const now = Date.now();
        store.saveVisit(ratedHeardVisit('likely', 'Blue Jay', now - 3_000, 'likely'));
        store.saveVisit(ratedHeardVisit('possible', 'Tufted Titmouse', now - 2_000, 'possible'));
        store.saveVisit(ratedHeardVisit('check', 'Dunlin', now - 1_000, 'check'), { review: true });
        store.saveVisit(makeHeardVisit('unrated', 'Carolina Wren', now - 4_000));

        assert.equal(store.hasSpecies('Blue Jay'), true);
        assert.equal(store.hasSpecies('Carolina Wren'), true, 'a visit from before the confidence layer counts as it always did');
        assert.equal(store.hasSpecies('Tufted Titmouse'), false);
        assert.equal(store.hasSpecies('Dunlin'), false);
        assert.deepEqual(store.speciesList().map(item => item.species).sort(), ['Blue Jay', 'Carolina Wren']);
        assert.equal(store.latestCountedVisit('88').id, 'likely', 'a newer Possible or Check call is not the camera\'s latest sighting');
        assert.deepEqual(store.listReview().map(visit => visit.id), ['check'], 'a Check call is in the review queue');
        assert.deepEqual(store.listVisits({ kind: 'heard' }).items.map(visit => visit.id).sort(), ['check', 'likely', 'possible', 'unrated'], 'but every call is still listed');

        store.recomputeFirstEverForSpecies('Blue Jay');
        store.recomputeFirstEverForSpecies('Dunlin');
        assert.equal(store.getVisit('likely').firstEver, true);
        assert.equal(store.getVisit('check').firstEver, false, 'a call that does not count is never the first visit');
        assert.equal(store.getVisit('likely').notify, true);
        assert.equal(store.getVisit('possible').notify, false);

        // A person confirms the Dunlin: now it counts, and it holds the first-ever flag.
        store.saveVisit({ ...store.getVisit('check'), status: 'confirmed' }, { review: false });
        store.recomputeFirstEverForSpecies('Dunlin');
        assert.equal(store.hasSpecies('Dunlin'), true);
        assert.equal(store.getVisit('check').firstEver, true);
        assert.equal(store.getVisit('check').notify, true);
        // ...and correcting the Possible call to a bird counts that bird.
        store.saveVisit({ ...store.getVisit('possible'), species: 'Hairy Woodpecker', status: 'corrected' });
        assert.equal(store.hasSpecies('Hairy Woodpecker'), true);
        assert.equal(store.hasSpecies('Tufted Titmouse'), false);
    } finally {
        store.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test('a fresh start (purge) only remembers species whose heard visits counted', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kestrel-purge-tier-test-'));
    const store = new KestrelStore(join(directory, 'kestrel.sqlite'));
    try {
        store.saveVisit(ratedHeardVisit('likely', 'Blue Jay', 1_000, 'likely'));
        store.saveVisit(ratedHeardVisit('possible', 'Tufted Titmouse', 2_000, 'possible'));
        store.saveVisit(ratedHeardVisit('confirmed-check', 'Dunlin', 3_000, 'check', 'confirmed'));
        const result = store.purgeHeardBefore(10_000, true);
        assert.equal(result.removed, 3);
        assert.equal(store.hasSpecies('Blue Jay'), true);
        assert.equal(store.hasSpecies('Dunlin'), true, 'a confirmed call is remembered');
        assert.equal(store.hasSpecies('Tufted Titmouse'), false, 'a Possible call never made its species known');
    } finally {
        store.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test('a database from before the confidence layer opens, gains the tier column and heard_calls, and its visits keep counting', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kestrel-migrate-test-'));
    const path = join(directory, 'kestrel.sqlite');
    try {
        const old = new DatabaseSync(path);
        // visits exactly as it was before birdnet_detection_id, birdnet_clip and tier existed.
        old.exec(`CREATE TABLE visits (
            id TEXT PRIMARY KEY, camera_id TEXT NOT NULL, camera_name TEXT NOT NULL, kind TEXT NOT NULL, started_at INTEGER NOT NULL,
            species TEXT NOT NULL, grp TEXT NOT NULL, status TEXT NOT NULL, score REAL, detection_label TEXT, snapshot_file TEXT, crop_file TEXT,
            clip_file TEXT, audio_file TEXT, clip_state TEXT NOT NULL DEFAULT 'pending', clip_expected_ready_at INTEGER,
            review_flag INTEGER NOT NULL DEFAULT 0, first_ever INTEGER NOT NULL DEFAULT 0, muted INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL,
            last_change_at INTEGER, undo_data TEXT, last_correction_id INTEGER, updated_at INTEGER NOT NULL)`);
        const visit = makeHeardVisit('old-heard', 'Blue Jay', Date.now() - 60_000);
        old.prepare(`INSERT INTO visits(id,camera_id,camera_name,kind,started_at,species,grp,status,score,clip_state,review_flag,first_ever,muted,data,updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('old-heard', '88', 'Backyard Camera', 'heard', visit.startedAt, 'Blue Jay', 'bird', 'auto', 0.8, 'none', 0, 1, 0, JSON.stringify(visit), Date.now());
        old.close();

        for (let opening = 0; opening < 2; opening++) {
            const store = new KestrelStore(path);
            try {
                const columns = store.db.prepare('PRAGMA table_info(visits)').all().map(column => column.name);
                assert.ok(columns.includes('tier'), `the tier column exists (opening ${opening + 1})`);
                assert.ok(columns.includes('birdnet_detection_id'));
                assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM heard_calls').get().n, 0, 'the heard_calls table exists');
                const decoded = store.getVisit('old-heard');
                assert.equal(decoded.tier, undefined, 'an older visit is not rated');
                assert.equal(decoded.firstEver, true);
                assert.equal(store.hasSpecies('Blue Jay'), true);
                assert.deepEqual(store.speciesList().map(item => item.species), ['Blue Jay']);
                store.saveVisit({ ...decoded, tier: 'possible' });
                assert.equal(store.getVisit('old-heard').tier, 'possible', 'and the new column is written and read back');
                store.saveVisit({ ...store.getVisit('old-heard'), tier: undefined });
            } finally {
                store.close();
            }
        }
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('heard calls: a repeat delivery is kept once, repeats are counted per microphone and species, the main model is the best one heard lately, and old calls are pruned', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kestrel-calls-test-'));
    const store = new KestrelStore(join(directory, 'kestrel.sqlite'));
    try {
        const day = 24 * 60 * 60 * 1000;
        const now = Date.parse('2026-10-03T13:00:00Z');
        const call = (species, at, extra = {}) => ({
            cameraId: '88', at, receivedAt: at + 15_000, species, scientific: null, grp: 'bird', score: 0.8, occurrence: 0.4,
            model: 'perch_v2', modelRank: 2, modelLabel: 'Perch v2', detectionId: 1, clip: null, ...extra,
        });
        const first = store.recordHeardCall(call('Blue Jay', now));
        assert.equal(typeof first, 'number');
        assert.equal(store.recordHeardCall(call('Blue Jay', now)), undefined, 'the same message delivered twice');
        const sameSecondOtherModel = store.recordHeardCall(call('Blue Jay', now, { model: 'birdnet_v3', modelRank: 3, modelLabel: 'BirdNET v3.0' }));
        assert.equal(typeof sameSecondOtherModel, 'number', 'a different model hearing it in the same second is its own call');
        const earlier = store.recordHeardCall(call('Blue Jay', now - 2 * 60_000));
        store.recordHeardCall(call('Blue Jay', now - 2 * 60_000, { cameraId: '103' }));
        store.recordHeardCall(call('American Crow', now - 2 * 60_000));
        store.recordHeardCall(call('Blue Jay', now - 6 * 60_000));
        assert.equal(store.countHeardCalls('88', 'Blue Jay', now - 5 * 60_000, now, first), 1, 'the call 2 minutes ago; not the other model\'s call of the same second, the 6-minute-old call, another microphone, another bird or itself');
        assert.equal(store.getHeardCall(earlier).visitId, null);
        store.attachHeardCall(earlier, 'v1');
        assert.equal(store.getHeardCall(earlier).visitId, 'v1');
        assert.deepEqual(store.heardCallsNear('88', now - 3 * 60_000, now - 1 * 60_000).map(item => item.species).sort(), ['American Crow', 'Blue Jay']);

        store.noteModelSeen('perch_v2', 2, now - 2 * day);
        store.noteModelSeen('birdnet_v3', 3, now - 3 * 60 * 60_000);
        assert.equal(store.primaryModelRank(now - day), 3, 'v3.0 spoke in the last day');
        assert.equal(store.primaryModelRank(now - 60_000), 0, 'nobody has spoken in the last minute');
        store.noteModelSeen('birdnet_v3', 3, now - 5 * day);
        assert.equal(store.primaryModelRank(now - day), 3, 'a message that arrives out of order never moves a model\'s last time back');

        store.recordHeardCall(call('Old Call', now - 40 * day));
        await store.prune(now, join(directory, 'media'), 1_000_000);
        assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM heard_calls WHERE species='Old Call'").get().n, 0, 'calls older than a month are pruned');
        assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM heard_calls WHERE species='Blue Jay'").get().n > 0, true);
    } finally {
        store.close();
        await rm(directory, { recursive: true, force: true });
    }
});
