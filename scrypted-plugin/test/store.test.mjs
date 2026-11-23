import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { KestrelStore, TRACK_MAX_FRAMES, TRACK_MAX_SPAN_MS } from '../src/store.ts';
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

test('heard calls keep BirdNET-Go\'s unlikely tag; a database from before the tag gains the column once, with every old call untagged', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kestrel-unlikely-test-'));
    const path = join(directory, 'kestrel.sqlite');
    const now = Date.parse('2026-11-23T04:00:00Z');
    const call = (species, at, extra = {}) => ({
        cameraId: '88', at, receivedAt: at + 15_000, species, scientific: null, grp: 'bird', score: 0.8, occurrence: 0.4,
        model: 'birdnet_v3', modelRank: 3, modelLabel: 'BirdNET v3.0', detectionId: 1, clip: null, unlikely: false, ...extra,
    });
    try {
        const first = new KestrelStore(path);
        const tagged = first.recordHeardCall(call('Blue Jay', now, { unlikely: true }));
        const plain = first.recordHeardCall(call('Blue Jay', now - 1_000));
        const notSaid = first.recordHeardCall({ ...call('American Crow', now - 2_000), unlikely: undefined });
        assert.deepEqual([tagged, plain, notSaid].map(id => first.getHeardCall(id).unlikely), [true, false, false]);
        first.close();
        // The database as it was before the tag: the column taken away again.
        const old = new DatabaseSync(path);
        old.exec('ALTER TABLE heard_calls DROP COLUMN unlikely');
        assert.equal(old.prepare('PRAGMA table_info(heard_calls)').all().some(column => column.name === 'unlikely'), false);
        old.close();
        for (let opening = 0; opening < 2; opening++) {
            const store = new KestrelStore(path);
            try {
                const columns = store.db.prepare('PRAGMA table_info(heard_calls)').all().map(column => column.name);
                assert.equal(columns.filter(name => name === 'unlikely').length, 1, `the column exists once (opening ${opening + 1})`);
                assert.deepEqual([tagged, plain, notSaid].map(id => store.getHeardCall(id).unlikely), [false, false, false], 'a call from before the tag was never tagged');
                if (opening === 0) {
                    const later = store.recordHeardCall(call('Northern Cardinal', now, { unlikely: true }));
                    assert.equal(store.getHeardCall(later).unlikely, true);
                } else {
                    assert.equal(store.heardCallsNear('88', now, now).find(item => item.species === 'Northern Cardinal').unlikely, true, 'and it is still tagged after the next start');
                }
            } finally { store.close(); }
        }
    } finally { await rm(directory, { recursive: true, force: true }); }
});

// --- The boxes the detector drew during a visit (track.ts feeds them) ----------------------------------------------------------------------------

const box = (extra = {}) => ({ x: 0.453, y: 0.769, w: 0.064, h: 0.132, className: 'animal', score: 0.82, id: 'w1', ...extra });
const event = (t, extra) => ({ t, boxes: [box(extra)] });
const rows = (store, id) => Number(store.db.prepare('SELECT COUNT(*) AS n FROM visit_boxes WHERE visit_id=?').get(id).n);
const times = (store, id) => store.getTrack(id).frames.map(frame => frame.t);

async function withStore(run) {
    const directory = await mkdtemp(join(tmpdir(), 'kestrel-track-store-'));
    const store = new KestrelStore(join(directory, 'kestrel.sqlite'));
    try { await run(store, directory); }
    finally { store.close(); await rm(directory, { recursive: true, force: true }); }
}

test('a visit\'s detection events survive a restart, come back oldest first with every box as it was, and a visit read from the store never carries them', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kestrel-track-store-'));
    const path = join(directory, 'kestrel.sqlite');
    try {
        let store = new KestrelStore(path);
        store.saveVisit(makeVisit('v1', 'Raccoon', 0.8, 5_000));
        const named = box({ id: 'w2', label: 'Common Raccoon', labelScore: 0.93, x: 0.5 });
        store.appendTrackFrames('v1', [event(5_000), { t: 5_250, boxes: [box(), named] }, event(5_500)]);
        store.appendTrackFrames('v1', [event(5_250, { x: 0.9 })]);               // a time that is already kept: the first one wins
        store.close();

        store = new KestrelStore(path);
        assert.deepEqual(store.getTrack('v1'), { clipStartAt: null, clipOffsetMs: null, frames: [event(5_000), { t: 5_250, boxes: [box(), named] }, event(5_500)] });
        const visit = store.getVisit('v1');
        assert.equal('detections' in visit, false);
        assert.equal('detections' in store.listVisits().items[0], false, 'lists do not carry them either');
        assert.equal('detections' in JSON.parse(store.getRawVisit('v1').data), false, 'and they are not part of the stored visit');
        store.close();
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test('only a seen visit whose clip was not deleted has a track; an unknown visit, a heard visit and the empty list are ignored', async () => {
    await withStore(store => {
        store.saveVisit(makeHeardVisit('heard', 'Blue Jay', 1_000));
        store.saveVisit(makeVisit('seen', 'Raccoon', 0.8, 1_000));
        store.appendTrackFrames('ghost', [event(1_000)]);
        store.appendTrackFrames('heard', [event(1_000)]);
        store.appendTrackFrames('seen', []);
        assert.equal(Number(store.db.prepare('SELECT COUNT(*) AS n FROM visit_boxes').get().n), 0);
        // The foreign key is real: a row for a visit that is not there cannot be written by any path.
        assert.throws(() => store.db.prepare('INSERT INTO visit_boxes(visit_id,t,boxes) VALUES(?,?,?)').run('ghost', 1, '[]'), /FOREIGN KEY/);
        assert.deepEqual(store.getTrack('ghost'), { clipStartAt: null, clipOffsetMs: null, frames: [] });
        assert.deepEqual(store.getTrack('seen'), { clipStartAt: null, clipOffsetMs: null, frames: [] });
        // A visit whose clip is deleted has nothing to draw on, so a late event does not start a new track.
        store.setClip('seen', 'ready', '/clips/seen.mp4', { source: 'events', startAt: 900 });
        store.appendTrackFrames('seen', [event(1_000)]);
        assert.equal(rows(store, 'seen'), 1);
        store.setClip('seen', 'deleted', null);
        assert.equal(rows(store, 'seen'), 0);
        store.appendTrackFrames('seen', [event(1_250)]);
        assert.equal(rows(store, 'seen'), 0);
    });
});

test('a visit keeps at most 480 events and none later than 90 s after its first: whatever would break either is dropped, whichever call it comes in', async () => {
    assert.equal(TRACK_MAX_FRAMES, 480);
    assert.equal(TRACK_MAX_SPAN_MS, 90_000);
    await withStore(store => {
        // By count: 600 events 100 ms apart (a minute), in two calls.
        store.saveVisit(makeVisit('many', 'Raccoon', 0.8, 0));
        store.appendTrackFrames('many', Array.from({ length: 300 }, (_, index) => event(1_000 + index * 100)));
        assert.equal(rows(store, 'many'), 300);
        store.appendTrackFrames('many', Array.from({ length: 300 }, (_, index) => event(1_000 + (300 + index) * 100)));
        assert.equal(rows(store, 'many'), 480);
        assert.equal(times(store, 'many')[479], 1_000 + 479 * 100, 'the first 480 stay');
        store.appendTrackFrames('many', [event(1_000 + 50)]);
        assert.equal(rows(store, 'many'), 480, 'a full visit takes nothing more, not even an event between two it has');

        // By span: one event a second for two minutes. The event exactly 90 s after the first stays, the next does not.
        store.saveVisit(makeVisit('long', 'Raccoon', 0.8, 0));
        store.appendTrackFrames('long', Array.from({ length: 121 }, (_, index) => event(10_000 + index * 1_000)));
        const kept = times(store, 'long');
        assert.equal(kept.length, 91);
        assert.equal(kept[0], 10_000);
        assert.equal(kept[90], 100_000);
        store.appendTrackFrames('long', [event(100_001), event(130_000)]);
        assert.equal(rows(store, 'long'), 91, 'later calls cannot add what is too late either');
        store.appendTrackFrames('long', [event(45_500)]);
        assert.equal(rows(store, 'long'), 92, 'while an event inside the span is still welcome');

        // Events older than everything kept move the first one back: whatever then lies beyond 90 s from it goes.
        store.saveVisit(makeVisit('older', 'Raccoon', 0.8, 0));
        store.appendTrackFrames('older', [event(100_000), event(110_000), event(130_000), event(150_000)]);
        store.appendTrackFrames('older', [event(20_000), event(25_000)]);
        assert.deepEqual(times(store, 'older'), [20_000, 25_000, 100_000, 110_000]);
        store.appendTrackFrames('older', [event(10_000), event(105_000)]);
        assert.deepEqual(times(store, 'older'), [10_000, 20_000, 25_000, 100_000], 'the first moved back to 10 s: 110 s is now more than 90 s after it and goes, and 105 s is too late');
    });
});

test('deleting a visit by any path removes its detection events and nobody else\'s: the visit row, the repair and the three-year retention', async () => {
    await withStore(async (store, directory) => {
        const announced = [];
        store.onVisitsDeleted = ids => announced.push(...ids);
        const now = Date.parse('2026-10-30T12:00:00Z');
        const year = 365 * 24 * 60 * 60 * 1000;
        for (const [id, startedAt] of [['a', now - 1_000], ['b', now - 2_000], ['expired', now - 3 * year - 60_000]]) {
            store.saveVisit(makeVisit(id, 'Raccoon', 0.8, startedAt));
            store.appendTrackFrames(id, [event(startedAt), event(startedAt + 300)]);
            // A clip that is there: the retention is the only thing that can remove the track of the oldest visit.
            store.setClip(id, 'ready', `/NVR/kestrel/clips/88/${id}.mp4`, { source: 'events', startAt: startedAt - 100 });
        }
        store.deleteVisitRow('a');
        assert.deepEqual([rows(store, 'a'), rows(store, 'b'), rows(store, 'expired')], [0, 2, 2]);
        await store.prune(now, join(directory, 'media'), 1_000_000);
        assert.deepEqual([rows(store, 'a'), rows(store, 'b'), rows(store, 'expired')], [0, 2, 0]);
        assert.deepEqual(announced.sort(), ['a', 'expired']);
        assert.equal(Number(store.db.prepare('SELECT COUNT(*) AS n FROM visit_boxes WHERE visit_id NOT IN (SELECT id FROM visits)').get().n), 0, 'no row is left without its visit');
        // Heard visits are purged without touching a seen visit's events.
        store.saveVisit(makeHeardVisit('call', 'Blue Jay', now - 4_000));
        assert.equal(store.purgeHeardBefore(now, true).removed, 1);
        assert.equal(rows(store, 'b'), 2);
    });
});

test('a ready clip knows when it starts, no other state does; a deleted clip takes the track along, and a pending, missing or ready one keeps it', async () => {
    await withStore(store => {
        store.saveVisit(makeVisit('v', 'Raccoon', 0.8, 5_000));
        store.appendTrackFrames('v', [event(5_000), event(5_300), event(5_600)]);
        const start = () => store.getRawVisit('v').clip_start_at;

        store.setClip('v', 'ready', '/NVR/clips/88/videoclips/1.mp4', { source: 'events', startAt: 4_400 });
        assert.equal(start(), 4_400);
        assert.deepEqual(store.getTrack('v').clipStartAt, 4_400);
        // Copying the clip into Kestrel's store later, or saving the visit for another reason, does not disturb it.
        store.markClipKept('v', '/NVR/kestrel/clips/88/v.mp4', 99);
        assert.equal(start(), 4_400);
        store.saveVisit({ ...store.getVisit('v'), species: 'Coyote', status: 'corrected' });
        assert.equal(start(), 4_400);
        assert.equal(store.getVisit('v').clip.source, 'events');

        store.setClip('v', 'pending', null);
        assert.equal(start(), null, 'a clip that is not ready has no start');
        assert.equal(rows(store, 'v'), 3, 'and the track stays: the clip may still come');
        store.setClip('v', 'ready', '/NVR/kestrel/clips/88/v.mp4', { source: 'nvr', startAt: 4_500 });
        assert.equal(start(), 4_500, 'a new clip says its own start');
        store.setClip('v', 'none', null);
        assert.equal(start(), null);
        assert.equal(rows(store, 'v'), 3, 'no clip: the backfill may still recover one, so the track stays');
        store.setClip('v', 'ready', '/NVR/clips/88/videoclips/2.mp4', { source: 'events' });
        assert.equal(start(), null, 'a clip whose start was never recorded is stored as unknown');
        assert.deepEqual(store.getTrack('v').clipStartAt, null);
        store.setClip('v', 'ready', '/NVR/clips/88/videoclips/2.mp4', { source: 'events', startAt: 4_450 });
        assert.equal(start(), 4_450);
        store.setClip('v', 'ready', '/NVR/clips/88/videoclips/2.mp4', { source: 'events', startAt: null });
        assert.equal(start(), null, 'a start that could not be told replaces an earlier one with nothing: the clip is a new clip');
        assert.equal(store.getVisit('v').clip.state, 'ready', 'and the clip is ready all the same');
        assert.equal(rows(store, 'v'), 3, 'the boxes are kept');
        store.setClip('v', 'ready', '/NVR/clips/88/videoclips/2.mp4', { source: 'events', startAt: 4_450 });
        store.setClip('v', 'deleted', null, { deletedBy: 'user' });
        assert.equal(start(), null);
        assert.equal(rows(store, 'v'), 0, 'a deleted clip has nothing left to draw on');
        assert.equal(store.getVisit('v').clip.state, 'deleted');
    });
});

test('the nightly prune drops the detection events of visits that never got a clip and started over 30 days ago, and of nobody else', async () => {
    await withStore(async (store, directory) => {
        const now = Date.parse('2026-10-30T12:00:00Z');
        const day = 24 * 60 * 60 * 1000;
        const seed = (id, startedAt, state) => {
            store.saveVisit(makeVisit(id, 'Raccoon', 0.8, startedAt));
            store.appendTrackFrames(id, [event(startedAt), event(startedAt + 300)]);
            if (state === 'ready') store.setClip(id, 'ready', `/NVR/kestrel/clips/88/${id}.mp4`, { source: 'events', startAt: startedAt - 100, kept: true, bytes: 10 });
            else store.setClip(id, state, null);
        };
        seed('none-old', now - 31 * day, 'none');
        seed('none-edge', now - 30 * day + 60_000, 'none');
        seed('none-recent', now - 2 * day, 'none');
        seed('pending-old', now - 40 * day, 'pending');
        seed('ready-old', now - 400 * day, 'ready');
        seed('ready-recent', now - 2 * day, 'ready');
        await store.prune(now, join(directory, 'media'), 1_000_000);
        const left = Object.fromEntries(['none-old', 'none-edge', 'none-recent', 'pending-old', 'ready-old', 'ready-recent'].map(id => [id, rows(store, id)]));
        assert.deepEqual(left, { 'none-old': 0, 'none-edge': 2, 'none-recent': 2, 'pending-old': 2, 'ready-old': 2, 'ready-recent': 2 });
        assert.deepEqual(store.getTrack('ready-old').clipStartAt, now - 400 * day - 100, 'a kept clip\'s events stay as long as the visit, whatever the media budget');
        assert.ok(store.getVisit('none-old'), 'the visit itself stays');
    });
});

test('the split-visit repair moves the dropped visit\'s detection events to the kept visit (its own win a clash) and adopts the clip start together with the clip', async () => {
    await withStore(async store => {
        store.saveVisit(makeVisit('keep', 'Common Raccoon', 0.84, 10_000));
        store.saveVisit(makeVisit('drop', 'Southern Flying Squirrel', 0.82, 10_750));
        store.appendTrackFrames('keep', [event(10_000, { id: 'keep-1' }), event(10_250, { id: 'keep-2' })]);
        store.appendTrackFrames('drop', [event(10_250, { id: 'drop-clash' }), event(10_500, { id: 'drop-3' }), event(10_750, { id: 'drop-4' })]);
        store.setClip('drop', 'ready', '/NVR/clips/88/videoclips/1.mp4', { source: 'events', startAt: 10_555 });
        store.setClipAlignment('drop', 330, 77);
        assert.equal(await store.repairSplitSeenVisit('keep', 'drop'), 'merged');
        assert.equal(store.getVisit('drop'), undefined);
        assert.equal(rows(store, 'drop'), 0, 'nothing is left of the dropped visit');
        const track = store.getTrack('keep');
        assert.deepEqual(track.frames.map(frame => [frame.t, frame.boxes[0].id]), [[10_000, 'keep-1'], [10_250, 'keep-2'], [10_500, 'drop-3'], [10_750, 'drop-4']]);
        assert.equal(track.clipStartAt, 10_555, 'the kept visit took the dropped visit\'s clip and with it when that clip starts');
        assert.deepEqual([track.clipOffsetMs, store.getRawVisit('keep').clip_aligned_at], [330, 77], 'and what was measured for that clip');
        assert.equal(store.getVisit('keep').clip.state, 'ready');
        assert.equal(store.getVisit('keep').clip.source, 'events');

        // A kept visit that has a clip of its own keeps its own start, and still takes the events.
        store.saveVisit(makeVisit('keep2', 'Common Raccoon', 0.84, 20_000));
        store.saveVisit(makeVisit('drop2', 'Southern Flying Squirrel', 0.82, 20_750));
        store.setClip('keep2', 'ready', '/NVR/kestrel/clips/88/keep2.mp4', { source: 'nvr', startAt: 15_000 });
        store.setClip('drop2', 'ready', '/NVR/clips/88/videoclips/2.mp4', { source: 'events', startAt: 20_555 });
        store.appendTrackFrames('drop2', [event(20_750)]);
        assert.equal(await store.repairSplitSeenVisit('keep2', 'drop2'), 'merged');
        assert.deepEqual([store.getTrack('keep2').clipStartAt, times(store, 'keep2'), store.getVisit('keep2').clip.source], [15_000, [20_750], 'nvr']);

        // Neither visit has a clip: the events move, the start stays unknown.
        store.saveVisit(makeVisit('keep3', 'Common Raccoon', 0.84, 30_000));
        store.saveVisit(makeVisit('drop3', 'Southern Flying Squirrel', 0.82, 30_750));
        store.appendTrackFrames('drop3', [event(30_750), event(31_000)]);
        assert.equal(await store.repairSplitSeenVisit('keep3', 'drop3'), 'merged');
        assert.deepEqual(store.getTrack('keep3'), { clipStartAt: null, clipOffsetMs: null, frames: [event(30_750), event(31_000)] });
    });
});

test('a row of detection events that cannot be read is skipped and the others are still returned', async () => {
    await withStore(store => {
        store.saveVisit(makeVisit('v', 'Raccoon', 0.8, 1_000));
        store.appendTrackFrames('v', [event(1_000), event(1_600)]);
        const put = store.db.prepare('INSERT INTO visit_boxes(visit_id,t,boxes) VALUES(?,?,?)');
        put.run('v', 1_200, '{not json');
        put.run('v', 1_300, '{"x":1}');
        put.run('v', 1_400, 'null');
        assert.deepEqual(times(store, 'v'), [1_000, 1_600]);
    });
});

test('a database from before detection boxes opens, gains clip_start_at and visit_boxes, keeps every visit as it was, and can then record boxes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kestrel-track-migrate-'));
    const path = join(directory, 'kestrel.sqlite');
    try {
        const old = new DatabaseSync(path);
        // visits exactly as it was the day before clip_start_at: every other clip column is already there.
        old.exec(`CREATE TABLE visits (
            id TEXT PRIMARY KEY, camera_id TEXT NOT NULL, camera_name TEXT NOT NULL, kind TEXT NOT NULL, started_at INTEGER NOT NULL,
            species TEXT NOT NULL, grp TEXT NOT NULL, status TEXT NOT NULL, score REAL, detection_label TEXT, snapshot_file TEXT, crop_file TEXT,
            clip_file TEXT, audio_file TEXT, clip_state TEXT NOT NULL DEFAULT 'pending', clip_expected_ready_at INTEGER,
            review_flag INTEGER NOT NULL DEFAULT 0, first_ever INTEGER NOT NULL DEFAULT 0, muted INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL,
            last_change_at INTEGER, undo_data TEXT, last_correction_id INTEGER, updated_at INTEGER NOT NULL,
            birdnet_detection_id INTEGER, birdnet_clip TEXT, tier TEXT,
            clip_source TEXT, clip_kept INTEGER NOT NULL DEFAULT 0, clip_bytes INTEGER, clip_deleted_by TEXT)`);
        const seen = { ...makeVisit('old-seen', 'Raccoon', 0.8, 5_000), clip: { state: 'ready', expectedReadyAt: 50_000 } };
        const heard = makeHeardVisit('old-heard', 'Blue Jay', 6_000);
        const insert = old.prepare(`INSERT INTO visits(id,camera_id,camera_name,kind,started_at,species,grp,status,score,clip_file,clip_state,clip_expected_ready_at,first_ever,data,updated_at,clip_source,clip_kept,clip_bytes)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
        insert.run('old-seen', '88', 'Backyard Camera', 'seen', 5_000, 'Raccoon', 'mammal', 'auto', 0.8, '/NVR/kestrel/clips/88/old-seen.mp4', 'ready', 50_000, 1, JSON.stringify(seen), 1, 'nvr', 1, 4_321);
        insert.run('old-heard', '88', 'Backyard Camera', 'heard', 6_000, 'Blue Jay', 'bird', 'auto', 0.8, null, 'none', null, 0, JSON.stringify(heard), 1, null, 0, null);
        old.close();

        for (let opening = 0; opening < 2; opening++) {
            const store = new KestrelStore(path);
            try {
                const columns = store.db.prepare('PRAGMA table_info(visits)').all().map(column => column.name);
                assert.ok(columns.includes('clip_start_at'), `the column exists (opening ${opening + 1})`);
                assert.equal(columns.filter(name => name === 'clip_start_at').length, 1);
                for (const name of ['clip_offset_ms', 'clip_aligned_at']) assert.equal(columns.filter(column => column === name).length, 1, `${name} exists once (opening ${opening + 1})`);
                assert.deepEqual(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='visit_boxes'").all().map(row => row.name), ['visit_boxes']);
                assert.equal(store.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
                assert.equal(store.db.prepare('PRAGMA foreign_key_list(visit_boxes)').get().on_delete, 'CASCADE');
                // Old visits are as they were, and a clip from before the start was recorded has no start.
                const decoded = store.getVisit('old-seen');
                assert.equal(decoded.species, 'Raccoon');
                assert.deepEqual(decoded.clip, { state: 'ready', expectedReadyAt: 50_000, url: 'media/clip/old-seen.mp4', source: 'nvr' });
                assert.equal(store.getRawVisit('old-seen').clip_bytes, 4_321);
                assert.equal(store.getVisit('old-heard').kind, 'heard');
                assert.equal(store.listVisits().items.length, 2);
                if (opening === 0) {
                    assert.equal(store.getRawVisit('old-seen').clip_start_at, null, 'the start of an old clip is not known');
                    assert.deepEqual(store.getTrack('old-seen'), { clipStartAt: null, clipOffsetMs: null, frames: [] });
                    // And the new things work on it.
                    store.appendTrackFrames('old-seen', [event(5_000), event(5_300)]);
                    store.setClip('old-seen', 'ready', '/NVR/kestrel/clips/88/old-seen.mp4', { source: 'nvr', startAt: 4_900, kept: true, bytes: 4_321 });
                } else {
                    assert.deepEqual(store.getTrack('old-seen'), { clipStartAt: 4_900, clipOffsetMs: null, frames: [event(5_000), event(5_300)] }, 'what was recorded after the upgrade is still there after the next start');
                }
            } finally {
                store.close();
            }
        }
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

// --- Lining the boxes up with the video (align.ts): what is kept with a clip, and which clips are still to be looked at -----------------------------

test('a database from before the boxes were lined up opens, gains clip_offset_ms and clip_aligned_at, keeps its visits and boxes, and then records an alignment', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kestrel-align-migrate-'));
    const path = join(directory, 'kestrel.sqlite');
    try {
        // The first store ever made, then the two new columns taken away again: what the database was the day before this existed.
        const first = new KestrelStore(path);
        first.saveVisit(makeVisit('old-seen', 'Raccoon', 0.8, 5_000));
        first.appendTrackFrames('old-seen', [event(5_000), event(5_300)]);
        first.setClip('old-seen', 'ready', '/NVR/kestrel/clips/88/old-seen.mp4', { source: 'nvr', startAt: 4_900, kept: true, bytes: 4_321 });
        first.close();
        const old = new DatabaseSync(path);
        old.exec('ALTER TABLE visits DROP COLUMN clip_offset_ms; ALTER TABLE visits DROP COLUMN clip_aligned_at');
        assert.deepEqual(old.prepare('PRAGMA table_info(visits)').all().map(column => column.name).filter(name => name.startsWith('clip_a') || name === 'clip_offset_ms'), []);
        old.close();

        for (let opening = 0; opening < 2; opening++) {
            const store = new KestrelStore(path);
            try {
                const columns = store.db.prepare('PRAGMA table_info(visits)').all().map(column => column.name);
                for (const name of ['clip_offset_ms', 'clip_aligned_at']) assert.equal(columns.filter(column => column === name).length, 1, `${name} exists once (opening ${opening + 1})`);
                const raw = store.getRawVisit('old-seen');
                assert.deepEqual([raw.clip_offset_ms, raw.clip_aligned_at, raw.clip_start_at, raw.clip_bytes], opening === 0 ? [null, null, 4_900, 4_321] : [-440, 99_000, 4_900, 4_321]);
                assert.deepEqual(store.getTrack('old-seen'), { clipStartAt: 4_900, clipOffsetMs: opening === 0 ? null : -440, frames: [event(5_000), event(5_300)] });
                assert.equal(store.getVisit('old-seen').clip.source, 'nvr');
                if (opening === 0) {
                    assert.deepEqual(store.listUnaligned(0, 10).map(row => row.id), [], 'two events are too few to be looked at');
                    store.setClipAlignment('old-seen', -440, 99_000);
                }
            } finally { store.close(); }
        }
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test('an alignment is kept with its ready clip and cleared whenever the clip is set again, whatever state it is set to; saving the visit or keeping a copy of the clip does not touch it', async () => {
    await withStore(store => {
        store.saveVisit(makeVisit('v', 'Raccoon', 0.8, 5_000));
        const aligned = () => { const raw = store.getRawVisit('v'); return [raw.clip_offset_ms, raw.clip_aligned_at]; };
        assert.deepEqual(aligned(), [null, null], 'a new visit has not been looked at');
        store.setClipAlignment('v', -440, 1_000);
        assert.deepEqual(aligned(), [null, null], 'a visit without a ready clip has nothing to line up');
        store.setClip('v', 'ready', '/NVR/clips/88/videoclips/1.mp4', { source: 'events', startAt: 4_400 });
        store.setClipAlignment('v', 330, 2_000);
        assert.deepEqual(aligned(), [330, 2_000]);
        assert.equal(store.getTrack('v').clipOffsetMs, 330);
        // Other writes leave it alone: a correction saves the visit again, keeping the copy moves the file.
        store.saveVisit({ ...store.getVisit('v'), species: 'Coyote', status: 'corrected' });
        store.markClipKept('v', '/NVR/kestrel/clips/88/v.mp4', 99);
        assert.deepEqual(aligned(), [330, 2_000]);
        // A clip set again is a new clip: in every state.
        for (const [state, file, details] of [['ready', '/NVR/kestrel/clips/88/v.mp4', { source: 'nvr', startAt: 4_500 }], ['pending', null, {}], ['none', null, {}], ['deleted', null, {}]]) {
            store.setClip('v', 'ready', '/NVR/clips/88/videoclips/1.mp4', { source: 'events', startAt: 4_400 });
            store.setClipAlignment('v', 330, 2_000);
            assert.deepEqual(aligned(), [330, 2_000]);
            store.setClip('v', state, file, details);
            assert.deepEqual(aligned(), [null, null], `set to ${state}`);
        }
        // "Nothing clear was found" is kept too, as a null offset with the time it was looked at.
        store.setClip('v', 'ready', '/NVR/clips/88/videoclips/1.mp4', { source: 'events', startAt: 4_400 });
        store.setClipAlignment('v', null, 3_000);
        assert.deepEqual(aligned(), [null, 3_000]);
        assert.equal(store.getTrack('v').clipOffsetMs, null);
    });
});

test('the clips still to be looked at: seen visits with a ready clip that starts at a known moment, whose file is there, with at least 6 events, started recently enough; the newest first', async () => {
    await withStore(async (store, directory) => {
        const day = 24 * 60 * 60 * 1000;
        const now = Date.parse('2026-10-30T12:00:00Z');
        const events = count => Array.from({ length: count }, (_, k) => event(now + k * 300));
        const present = join(directory, 'events-clip.mp4');
        await writeFile(present, 'a clip');
        const seed = (id, startedAt, { count = 6, clip = 'ready', startAt = startedAt - 100, kept = true, file = `/NVR/kestrel/clips/88/${id}.mp4`, kind = 'seen' } = {}) => {
            store.saveVisit(kind === 'seen' ? makeVisit(id, 'Raccoon', 0.8, startedAt) : makeHeardVisit(id, 'Blue Jay', startedAt));
            if (kind === 'seen') store.appendTrackFrames(id, events(count));
            if (clip === 'ready') store.setClip(id, 'ready', file, { source: 'events', startAt: startAt ?? undefined, kept, bytes: kept ? 10 : null });
            else store.setClip(id, clip, null);
            if (startAt === null) store.db.prepare('UPDATE visits SET clip_start_at=NULL WHERE id=?').run(id);
        };
        seed('newest', now - 1 * day);
        seed('older', now - 5 * day);
        seed('oldest-in-window', now - 13 * day);
        seed('too-old', now - 15 * day);
        seed('five-events', now - 2 * day, { count: 5 });
        seed('no-events', now - 2 * day, { count: 0 });
        seed('no-start', now - 2 * day, { startAt: null });
        seed('still-pending', now - 2 * day, { clip: 'pending' });
        seed('no-clip', now - 2 * day, { clip: 'none' });
        seed('deleted', now - 2 * day, { clip: 'ready' });
        store.setClip('deleted', 'deleted', null);
        seed('heard', now - 2 * day, { kind: 'heard', clip: 'none', count: 0 });
        seed('already-looked-at', now - 2 * day);
        store.setClipAlignment('already-looked-at', null, now);
        seed('other-plugins-file', now - 3 * day, { kept: false, file: present });
        seed('other-plugins-file-gone', now - 3 * day, { kept: false, file: join(directory, 'gone.mp4') });
        const since = now - 14 * day;
        assert.deepEqual(store.listUnaligned(since, 20).map(row => row.id), ['newest', 'other-plugins-file', 'older', 'oldest-in-window'], 'newest first; another plugin\'s file only while it is there');
        assert.deepEqual(store.listUnaligned(since, 2).map(row => row.id), ['newest', 'other-plugins-file'], 'at most the limit');
        assert.deepEqual(store.listUnaligned(now - 6 * day, 20).map(row => row.id), ['newest', 'other-plugins-file', 'older'], 'nothing that started before `since`');
        assert.deepEqual(store.listUnaligned(now - 15 * day, 20).map(row => row.id).slice(-2), ['oldest-in-window', 'too-old']);
        // Looking at one takes it off the list; replacing its clip puts it back.
        store.setClipAlignment('newest', 120, now);
        assert.deepEqual(store.listUnaligned(since, 1).map(row => row.id), ['other-plugins-file']);
        store.setClip('newest', 'ready', '/NVR/kestrel/clips/88/newest.mp4', { source: 'nvr', startAt: now - 1 * day - 5_000, kept: true, bytes: 10 });
        assert.deepEqual(store.listUnaligned(since, 1).map(row => row.id), ['newest']);
    });
});

test('a species sheet asks for one species: its entry is exactly the list\'s entry for it (found by the species index), and a species with no counted visit has none', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kestrel-entry-test-'));
    const store = new KestrelStore(join(directory, 'kestrel.sqlite'));
    try {
        const now = Date.now();
        const day = 24 * 60 * 60 * 1000;
        store.saveVisit(makeVisit('a1', 'Raccoon', 0.9, now - 40 * day));
        store.saveVisit(makeVisit('a2', 'Raccoon', 0.8, now - 2 * day, '99'));
        store.saveVisit(makeHeardVisit('h1', 'Blue Jay', now - 3 * day));
        store.saveVisit(makeHeardVisit('h2', 'Blue Jay', now - 1 * day));
        store.saveVisit(makeHeardVisit('h3', 'Carolina Wren', now - 5_000));
        store.saveVisit({ ...makeVisit('n1', 'Cat', 0.9, now - 1_000), status: 'not_animal' });
        store.considerSpeciesBest(store.getVisit('a1'), 'media/snap/a1.jpg', 'media/crop/a1.jpg');

        const list = store.speciesList('all', now);
        assert.deepEqual(list.map(item => item.species).sort(), ['Blue Jay', 'Carolina Wren', 'Raccoon']);
        for (const entry of list) assert.deepEqual(store.speciesEntry(entry.species, now), entry, entry.species);
        assert.equal(store.speciesEntry('Raccoon', now).hasPhoto, true);
        assert.equal(store.speciesEntry('Blue Jay', now).hasPhoto, false);
        assert.equal(store.speciesEntry('Cat', now), undefined, 'a visit marked "not an animal" is not a species');
        assert.equal(store.speciesEntry('Nobody', now), undefined);

        const plan = store.db.prepare('EXPLAIN QUERY PLAN SELECT species, started_at FROM visits WHERE species=? ORDER BY started_at').all('Blue Jay').map(row => row.detail).join(' ');
        assert.match(plan, /visits_species_started/, 'one species\' visits are found by index, not by reading every visit');
    } finally {
        store.close();
        await rm(directory, { recursive: true, force: true });
    }
});
