import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
    HeardIngest, PAIR_WINDOW_MS, SECOND_OPINION_SETTLE_MS, SETTLE_MS, decideTier, isDisagreement, isRareHere, modelOf, occurrenceOf, readBirdnetMessage,
} from '../src/heard.ts';
import { linkSeenAndHeard } from '../src/link.ts';
import { KestrelStore } from '../src/store.ts';

// Real BirdNET-Go 20260823 payload shape (captured over MQTT 2026-10-03): the model is a nested object, `occurrence` is
// 0-1, and an agreed bird is ONE message whose `Model` is whichever model scored higher.
const T = Date.parse('2026-10-03T13:00:00Z');
const MODELS = {
    v3: { model: 'birdnet_v3', modelRank: 3, modelLabel: 'BirdNET v3.0' },
    perch: { model: 'perch_v2', modelRank: 2, modelLabel: 'Perch v2' },
};
const CAMERAS = { 88: 'Backyard Camera', 103: 'Back Door Camera' };

function heardCall(species, score, at, { model = 'v3', occurrence = 0.5, camera = '88', received = at + 15_000, scientific = null, grp = 'bird', unlikely = false } = {}) {
    return { cameraId: camera, at, receivedAt: received, species, scientific, grp, score, occurrence, ...MODELS[model], detectionId: at % 100_000, clip: `${species}.opus`, unlikely };
}

async function withHarness(run, { cooldownMs = 10 * 60_000, usual = () => [], muted = [], commonness } = {}) {
    const directory = await mkdtemp(join(tmpdir(), 'kestrel-heard-test-'));
    const store = new KestrelStore(join(directory, 'kestrel.sqlite'));
    const events = [];
    let ids = 0;
    const ingest = new HeardIngest({
        store,
        cooldownMs: () => cooldownMs,
        cameraName: cameraId => CAMERAS[cameraId],
        isMuted: species => muted.includes(species),
        usualSuggestions: usual,
        commonness,
        newId: () => `visit-${++ids}`,
        created: visit => events.push(['visit_new', visit.id]),
        updated: visit => events.push(['visit_updated', visit.id]),
        link: visit => linkSeenAndHeard(store, visit, other => events.push(['visit_updated', other.id])),
        failed: error => { throw error; },
    });
    // Feeds calls the way main.ts does (each when BirdNET-Go delivers it), then lets the waits run out.
    const hear = (...calls) => { for (const call of calls) ingest.receive(call); };
    const settle = (afterMs = SECOND_OPINION_SETTLE_MS + 1_000) => ingest.flush(Math.max(...[T, ...store.db.prepare('SELECT received_at FROM heard_calls').all().map(row => row.received_at)]) + afterMs);
    const visits = () => store.listVisits({ kind: 'heard', limit: 50 }).items.sort((a, b) => a.startedAt - b.startedAt);
    try { await run({ store, ingest, events, hear, settle, visits }); }
    finally { store.close(); await rm(directory, { recursive: true, force: true }); }
}

// The main model has been heard recently (the 24-hour memory is what makes Perch "the second opinion").
function v3IsRunning(store) {
    store.noteModelSeen('birdnet_v3', 3, T - 60 * 60_000);
}

function knownSpecies(store, species) {
    store.saveVisit({
        id: `known-${species}`, camera: { id: '88', name: 'Backyard Camera' }, kind: 'heard', startedAt: T - 3 * 24 * 60 * 60_000, species, grp: 'bird',
        status: 'confirmed', score: 0.9, snapshot: null, crop: null, clip: { state: 'none', expectedReadyAt: null }, heard: null, audio: null,
        suggestions: [], firstEver: false, muted: false, notify: false,
    });
}

// --- reading what BirdNET-Go sends ----------------------------------------------------------------

test('the model is read from BirdNET-Go\'s nested Model object and from flat modelName/modelVersion; no model is an unrated source', () => {
    assert.deepEqual(modelOf({ Model: { Name: 'Perch', Version: 'V2', Variant: 'default' } }), { key: 'perch_v2', label: 'Perch v2', rank: 2 });
    assert.deepEqual(modelOf({ Model: { Name: 'BirdNET', Version: '3.0' } }), { key: 'birdnet_v3', label: 'BirdNET v3.0', rank: 3 });
    assert.deepEqual(modelOf({ Model: { Name: 'BirdNET', Version: '2.4' } }), { key: 'birdnet_v24', label: 'BirdNET v2.4', rank: 1 });
    assert.equal(modelOf({ modelName: 'BirdNET', modelVersion: '3.0' }).key, 'birdnet_v3');
    assert.equal(modelOf({ modelName: 'BirdNET' }).key, 'birdnet_v24', 'a BirdNET without a version is the old 2.4');
    assert.deepEqual(modelOf({ CommonName: 'Blue Jay' }), { key: 'other', label: 'BirdNET-Go', rank: 0 });
});

test('occurrence is a 0-1 chance or "not known", never a made-up number', () => {
    assert.equal(occurrenceOf({ occurrence: 0.5629528760910034 }), 0.5629528760910034);
    assert.equal(occurrenceOf({ occurrence: '0.4' }), 0.4);
    assert.equal(occurrenceOf({}), null, 'BirdNET-Go leaves the field out when it is 0: that is "not known", not "impossible"');
    assert.equal(occurrenceOf({ occurrence: 7 }), null);
    assert.equal(occurrenceOf({ occurrence: 'lots' }), null);
});

test('a bird is rare here when either BirdNET-Go\'s occurrence or the local sightings table says so; unknown is never rare', () => {
    assert.equal(isRareHere(0.05, null), true);
    assert.equal(isRareHere(0.5, 0.02), true, 'local sightings can call a bird rare that BirdNET-Go thinks is possible');
    assert.equal(isRareHere(0.5, 0.9), false);
    assert.equal(isRareHere(null, null), false);
    assert.equal(isRareHere(undefined), false);
});

test('the models disagree only when they name different birds and one of them is at least 50% sure', () => {
    assert.equal(isDisagreement({ species: 'Blue Jay', score: 0.82 }, { species: 'American Crow', score: 0.6 }), true);
    assert.equal(isDisagreement({ species: 'Blue Jay', score: 0.45 }, { species: 'American Crow', score: 0.4 }), false);
    assert.equal(isDisagreement({ species: 'Blue Jay', score: 0.9 }, { species: 'Blue Jay', score: 0.6 }), false);
});

// --- the tier rules -------------------------------------------------------------------------------

const evidence = (overrides = {}) => ({ score: 0.9, corroborated: true, repeats: 0, rare: false, disagrees: false, newHere: false, agreed: false, unlikely: false, ...overrides });

test('the tier follows the plain rules: clear call, good call heard again, weak call, rare bird, second opinion, disagreement', () => {
    const rows = [
        [{}, 'likely', ['strong']],
        [{ repeats: 2 }, 'likely', ['strong', 'repeated']],
        [{ score: 0.65 }, 'possible', ['weak']],
        [{ score: 0.65, repeats: 1 }, 'likely', ['repeated']],
        [{ score: 0.55, repeats: 3 }, 'possible', ['weak']],
        [{ score: 0.65, newHere: true }, 'check', ['weak', 'new_here']],
        [{ newHere: true }, 'likely', ['strong']],
        [{ rare: true }, 'check', ['rare_here']],
        [{ rare: true, repeats: 1 }, 'check', ['rare_here']],
        [{ rare: true, repeats: 2 }, 'likely', ['strong', 'repeated']],
        [{ score: 0.65, rare: true, repeats: 1 }, 'check', ['rare_here']],
        [{ score: 0.5, rare: true }, 'check', ['rare_here', 'weak']],
        [{ disagrees: true }, 'check', ['models_disagree']],
        [{ corroborated: false }, 'possible', ['second_opinion_only']],
        [{ corroborated: false, newHere: true }, 'check', ['second_opinion_only', 'new_here']],
        [{ corroborated: false, rare: true, newHere: true }, 'check', ['second_opinion_only', 'rare_here', 'new_here']],
        [{ corroborated: false, repeats: 5 }, 'possible', ['second_opinion_only']],
        [{ score: null }, 'possible', ['weak']],
    ];
    for (const [overrides, tier, why] of rows)
        assert.deepEqual(decideTier(evidence(overrides)), { tier, why }, JSON.stringify(overrides));
});

test('BirdNET-Go\'s unlikely tag makes a call Check and never Likely; both models agreeing counts as hearing it again, and moves none of the other rules', () => {
    const rows = [
        [{ unlikely: true }, 'check', ['birdnet_unlikely']],
        [{ unlikely: true, score: 0.99, repeats: 4 }, 'check', ['birdnet_unlikely']],
        [{ unlikely: true, agreed: true }, 'check', ['birdnet_unlikely']],
        [{ unlikely: true, corroborated: false }, 'check', ['birdnet_unlikely']],
        [{ unlikely: true, score: 0.3 }, 'check', ['birdnet_unlikely']],
        [{ unlikely: true, disagrees: true }, 'check', ['models_disagree', 'birdnet_unlikely']],
        [{ agreed: true }, 'likely', ['strong', 'models_agree']],
        [{ agreed: true, score: 0.65 }, 'likely', ['models_agree']],
        [{ agreed: true, score: 0.6 }, 'likely', ['models_agree']],
        [{ agreed: true, score: 0.65, repeats: 1 }, 'likely', ['repeated', 'models_agree']],
        [{ agreed: true, score: 0.65, newHere: true }, 'likely', ['models_agree']],
        [{ agreed: true, score: 0.59 }, 'possible', ['weak']],
        [{ agreed: true, score: 0.55, repeats: 3 }, 'possible', ['weak']],
        [{ agreed: true, score: null }, 'possible', ['weak']],
        [{ agreed: true, score: 0.65, rare: true }, 'check', ['rare_here']],
        [{ agreed: true, score: 0.65, rare: true, repeats: 1 }, 'check', ['rare_here']],
        [{ agreed: true, rare: true }, 'check', ['rare_here']],
        [{ agreed: true, score: 0.65, rare: true, repeats: 2 }, 'likely', ['repeated', 'models_agree']],
        [{ agreed: true, disagrees: true }, 'check', ['models_disagree']],
        [{ agreed: true, corroborated: false }, 'possible', ['second_opinion_only']],
        [{ agreed: false, score: 0.65 }, 'possible', ['weak']],
    ];
    for (const [overrides, tier, why] of rows)
        assert.deepEqual(decideTier(evidence(overrides)), { tier, why }, JSON.stringify(overrides));
});

test('BirdNET-Go\'s unlikely flag is read from the message (only a real true counts), and is absent from a normal one', () => {
    const message = { CommonName: 'Blue Jay', Confidence: 0.9, detectionId: 12, sourceName: 'Backyard Camera', Model: { Name: 'BirdNET', Version: '3.0' } };
    const read = extra => readBirdnetMessage({ ...message, ...extra }, () => undefined, T);
    assert.equal(read({}).unlikely, false);
    assert.equal(read({ unlikely: true }).unlikely, true);
    assert.equal(read({ Unlikely: true }).unlikely, true);
    for (const value of [false, 'true', 1, null, 'yes']) assert.equal(read({ unlikely: value }).unlikely, false, JSON.stringify(value));
});

// --- one visit from two models --------------------------------------------------------------------

test('a clear v3.0 call of a bird never recorded is Likely, first-ever and announced once, only after the wait', async () => {
    await withHarness(({ store, hear, ingest, events, visits }) => {
        const call = heardCall('Pileated Woodpecker', 0.9, T);
        hear(call);
        ingest.flush(call.receivedAt + SETTLE_MS - 1);
        assert.deepEqual(events, [], 'the call waits for the other model before it becomes a visit');
        ingest.flush(call.receivedAt + SETTLE_MS);
        assert.deepEqual(events, [['visit_new', 'visit-1']]);
        const [visit] = visits();
        assert.equal(visit.tier, 'likely');
        assert.deepEqual(visit.tierWhy, ['strong']);
        assert.equal(visit.firstEver, true);
        assert.equal(visit.notify, true, 'only a Likely call may announce a first-ever species');
        assert.equal(visit.review, false);
        assert.equal(visit.occurrence, 0.5);
        assert.equal(visit.repeats, 0);
        assert.deepEqual(visit.models, [{ model: 'birdnet_v3', label: 'BirdNET v3.0', species: 'Pileated Woodpecker', score: 0.9, role: 'named' }]);
        assert.deepEqual(visit.audio, { birdnetDetectionId: call.detectionId, birdnetClip: 'Pileated Woodpecker.opus' });
        assert.equal(store.speciesList().length, 1);
    });
});

test('v3.0 and Perch naming different birds make ONE visit named by v3.0, flagged for review with Perch\'s bird as a suggestion, whichever message arrives first', async () => {
    for (const perchFirst of [false, true]) {
        await withHarness(({ store, hear, settle, events, visits }) => {
            const v3 = heardCall('Blue Jay', 0.82, T, { model: 'v3', received: T + 15_000 + (perchFirst ? 1_500 : 0) });
            const perch = heardCall('American Crow', 0.61, T + 2_000, { model: 'perch', received: T + 15_500 + (perchFirst ? 0 : 1_500) });
            hear(...(perchFirst ? [perch, v3] : [v3, perch]));
            settle();
            const heard = visits();
            assert.equal(heard.length, 1, `one visit (perch first: ${perchFirst})`);
            const [visit] = heard;
            assert.equal(visit.species, 'Blue Jay', 'v3.0\'s bird wins');
            assert.equal(visit.score, 0.82);
            assert.equal(visit.tier, 'check');
            assert.deepEqual(visit.tierWhy, ['models_disagree']);
            assert.equal(visit.review, true);
            assert.equal(visit.notify, false, 'a call the models disagree about is never announced');
            assert.equal(visit.firstEver, false);
            assert.deepEqual(visit.models.map(item => [item.model, item.species, item.role, item.score]),
                [['birdnet_v3', 'Blue Jay', 'named', 0.82], ['perch_v2', 'American Crow', 'other', 0.61]]);
            assert.deepEqual(visit.suggestions[0], { species: 'American Crow', why: 'model' });
            assert.deepEqual(store.listReview().map(item => item.id), [visit.id]);
            assert.deepEqual(events.filter(([type]) => type === 'visit_new'), [['visit_new', visit.id]], 'announced as one visit, once');
            assert.equal(store.speciesList().length, 0, 'a call that needs a look does not count toward the species list');
        });
    }
});

test('Perch alone, while v3.0 is running, is only a second opinion: Possible, or Check when the bird would be new; and it waits longer', async () => {
    await withHarness(({ store, hear, ingest, visits }) => {
        v3IsRunning(store);
        knownSpecies(store, 'Carolina Wren');
        const wren = heardCall('Carolina Wren', 0.92, T, { model: 'perch' });
        const dunlin = heardCall('Dunlin', 0.9, T + 60_000, { model: 'perch' });
        hear(wren);
        ingest.flush(wren.receivedAt + SETTLE_MS);
        assert.equal(visits().filter(visit => visit.species === 'Carolina Wren' && visit.tier).length, 0, 'the second opinion waits longer than the main model');
        hear(dunlin);
        ingest.flush(dunlin.receivedAt + SECOND_OPINION_SETTLE_MS);
        const byName = Object.fromEntries(visits().filter(visit => visit.tier).map(visit => [visit.species, visit]));
        assert.equal(byName['Carolina Wren'].tier, 'possible');
        assert.deepEqual(byName['Carolina Wren'].tierWhy, ['second_opinion_only']);
        assert.equal(byName['Carolina Wren'].review, false);
        assert.equal(byName.Dunlin.tier, 'check');
        assert.deepEqual(byName.Dunlin.tierWhy, ['second_opinion_only', 'new_here']);
        assert.equal(byName.Dunlin.review, true);
        assert.equal(byName.Dunlin.firstEver, false);
        assert.equal(byName.Dunlin.notify, false);
    });
});

test('when v3.0 has not spoken at all, Perch is the main model, so retiring v3.0 later needs no change', async () => {
    await withHarness(({ hear, settle, visits }) => {
        hear(heardCall('Northern Cardinal', 0.88, T, { model: 'perch' }));
        settle();
        const [visit] = visits();
        assert.equal(visit.tier, 'likely');
        assert.equal(visit.firstEver, true);
    });
});

test('a Possible or Check call is kept quietly: listed, but not counted, not the camera\'s latest, never first-ever; a person\'s confirmation makes it count', async () => {
    await withHarness(({ store, hear, settle, visits }) => {
        v3IsRunning(store);
        knownSpecies(store, 'Blue Jay');
        hear(heardCall('Blue Jay', 0.55, T), heardCall('Tufted Titmouse', 0.7, T + 3 * 60_000));
        settle();
        const byName = Object.fromEntries(visits().filter(visit => visit.tier).map(visit => [visit.species, visit]));
        assert.equal(byName['Blue Jay'].tier, 'possible');
        assert.equal(byName['Tufted Titmouse'].tier, 'check');
        assert.deepEqual(store.speciesList().map(item => item.species), ['Blue Jay'], 'a Possible call of a known bird and a Check call of a new one add nothing');
        assert.equal(store.speciesList()[0].last, T - 3 * 24 * 60 * 60_000, 'the species\' latest visit is the confirmed one, not the newer Possible call');
        assert.equal(store.hasSpecies('Tufted Titmouse'), false);
        assert.equal(store.latestCountedVisit('88')?.id, 'known-Blue Jay', 'the camera\'s latest sighting skips calls that do not count');
        const titmouse = byName['Tufted Titmouse'];
        store.saveVisit({ ...titmouse, status: 'confirmed', review: false }, { review: false });
        store.recomputeFirstEverForSpecies('Tufted Titmouse');
        assert.equal(store.hasSpecies('Tufted Titmouse'), true);
        assert.deepEqual(store.speciesList().map(item => item.species).sort(), ['Blue Jay', 'Tufted Titmouse']);
        assert.equal(store.getVisit(titmouse.id).firstEver, true, 'the confirmed call is the first visit that counts');
        assert.equal(store.latestCountedVisit('88').id, titmouse.id);
    });
});

test('hearing the bird again promotes a good call to Likely in place (one visit, one update) and the first-ever flag follows', async () => {
    await withHarness(({ store, hear, ingest, events, visits }) => {
        const first = heardCall('Scarlet Tanager', 0.65, T);
        hear(first);
        ingest.flush(first.receivedAt + SETTLE_MS);
        let [visit] = visits();
        assert.equal(visit.tier, 'check', 'a faint call of a bird never recorded is worth a look');
        assert.deepEqual(visit.tierWhy, ['weak', 'new_here']);
        assert.equal(visit.review, true);
        assert.equal(visit.firstEver, false);
        const again = heardCall('Scarlet Tanager', 0.7, T + 30_000);
        hear(again);
        ingest.flush(again.receivedAt + SETTLE_MS);
        [visit] = visits();
        assert.equal(visits().length, 1, 'the same bird inside the cooldown is the same visit');
        assert.equal(visit.repeats, 1);
        assert.equal(visit.tier, 'likely');
        assert.deepEqual(visit.tierWhy, ['repeated']);
        assert.equal(visit.review, false, 'it left the review queue by itself');
        assert.equal(visit.firstEver, true);
        assert.deepEqual(events, [['visit_new', 'visit-1'], ['visit_updated', 'visit-1']]);
        assert.equal(store.listReview().length, 0);
        assert.equal(store.speciesList().length, 1);
    });
});

test('repeats are counted on the same microphone within five minutes, before or after the first call, and a quiet minute never takes a tier away', async () => {
    await withHarness(({ hear, ingest, events, visits }) => {
        // Three earlier calls on this microphone: the first makes the visit, the other two are folded into it as repeats.
        const earlier = [T - 4 * 60_000, T - 3 * 60_000, T - 2 * 60_000].map(at => heardCall('Eastern Towhee', 0.85, at));
        for (const call of earlier) { hear(call); ingest.flush(call.receivedAt + SETTLE_MS); }
        assert.equal(visits().length, 1, 'the first call made the visit, the others folded into it');
        const [first] = visits();
        assert.equal(first.repeats, 2);
        assert.equal(first.tier, 'likely');
        // Another microphone does not share them.
        const backDoor = heardCall('Eastern Towhee', 0.7, T, { camera: '103' });
        hear(backDoor);
        ingest.flush(backDoor.receivedAt + SETTLE_MS);
        assert.equal(visits().find(visit => visit.camera.id === '103').repeats, 0);
        // Folding calls in a Likely visit is quiet: the dashboards hear about the first visit only.
        assert.deepEqual(events.map(([type]) => type), ['visit_new', 'visit_new']);
        // 7 minutes after the first call is still the same visit, but not a repeat "within five minutes".
        const late = heardCall('Eastern Towhee', 0.2, T - 4 * 60_000 + 7 * 60_000);
        hear(late);
        ingest.flush(late.receivedAt + SETTLE_MS);
        assert.equal(visits().find(visit => visit.camera.id === '88').repeats, 2);
        assert.equal(visits().find(visit => visit.camera.id === '88').tier, 'likely', 'a weak late call does not demote the visit');
    }, { cooldownMs: 10 * 60_000 });
});

test('a new visit after the cooldown counts the earlier calls as repeats', async () => {
    await withHarness(({ hear, ingest, visits }) => {
        const a = heardCall('Hooded Warbler', 0.9, T);
        hear(a);
        ingest.flush(a.receivedAt + SETTLE_MS);
        const b = heardCall('Hooded Warbler', 0.65, T + 2 * 60_000);
        hear(b);
        ingest.flush(b.receivedAt + SETTLE_MS);
        const [first, second] = visits();
        assert.equal(first.repeats, 0);
        assert.equal(second.repeats, 1, 'the call two minutes earlier is a repeat');
        assert.equal(second.tier, 'likely', 'a good call heard again');
    }, { cooldownMs: 60_000 });
});

test('a clear call of a bird that is rare here needs a repeat or two before it is Likely', async () => {
    await withHarness(({ hear, ingest, visits }) => {
        const first = heardCall('Chuck-will\'s-widow', 0.93, T, { occurrence: 0.05 });
        hear(first);
        ingest.flush(first.receivedAt + SETTLE_MS);
        let [visit] = visits();
        assert.equal(visit.tier, 'check');
        assert.deepEqual(visit.tierWhy, ['rare_here', 'new_here']);
        for (const [index, at] of [T + 20_000, T + 40_000].entries()) {
            const call = heardCall('Chuck-will\'s-widow', 0.9, at, { occurrence: 0.05 });
            hear(call);
            ingest.flush(call.receivedAt + SETTLE_MS);
            [visit] = visits();
            assert.equal(visit.tier, index === 0 ? 'check' : 'likely', `after ${index + 1} repeat(s)`);
        }
    });
});

test('a bird the local sightings table calls rare counts as rare here even when BirdNET-Go\'s own chance is fine', async () => {
    await withHarness(({ hear, settle, visits }) => {
        hear(heardCall('Dunlin', 0.9, T, { occurrence: 0.4, scientific: 'Calidris alpina' }));
        settle();
        const [visit] = visits();
        assert.equal(visit.commonness, 0.02);
        assert.equal(visit.tier, 'check');
        assert.ok(visit.tierWhy.includes('rare_here'));
    }, { commonness: scientific => (scientific === 'Calidris alpina' ? 0.02 : null) });
});

test('a message delivered twice is one call, and a muted species is announced to nobody', async () => {
    await withHarness(({ store, hear, settle, visits }) => {
        const call = heardCall('American Robin', 0.9, T);
        hear(call, { ...call, receivedAt: call.receivedAt + 40 });
        settle();
        assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM heard_calls').get().n, 1);
        const [visit] = visits();
        assert.equal(visit.repeats, 0, 'a duplicate delivery is not a repeat');
        assert.equal(visit.firstEver, true);
        assert.equal(visit.muted, true);
        assert.equal(visit.notify, false);
    }, { muted: ['American Robin'] });
});

test('a visit a person has decided is left exactly as they decided when the models say more', async () => {
    await withHarness(({ store, hear, ingest, events, visits }) => {
        const first = heardCall('Blue Jay', 0.85, T);
        hear(first);
        ingest.flush(first.receivedAt + SETTLE_MS);
        const [created] = visits();
        store.saveVisit({ ...created, status: 'confirmed' });
        events.length = 0;
        const perch = heardCall('American Crow', 0.7, T + 2_000, { model: 'perch', received: first.receivedAt + 2_000 });
        hear(perch);
        ingest.flush(perch.receivedAt + SECOND_OPINION_SETTLE_MS);
        const [after] = visits();
        assert.equal(after.tier, 'likely');
        assert.equal(after.review, false);
        assert.equal(after.status, 'confirmed');
        assert.deepEqual(events, [], 'nothing is announced');
        assert.equal(visits().length, 1, 'and the crow did not become a visit of its own');
    });
});

test('a visit from before the confidence layer stays unrated when the same bird is heard again', async () => {
    await withHarness(({ store, hear, ingest, events, visits }) => {
        store.saveVisit({
            id: 'old', camera: { id: '88', name: 'Backyard Camera' }, kind: 'heard', startedAt: T - 60_000, species: 'Blue Jay', grp: 'bird', status: 'auto', score: 0.5,
            snapshot: null, crop: null, clip: { state: 'none', expectedReadyAt: null }, heard: null, audio: null, suggestions: [], firstEver: true, muted: false, notify: false,
        });
        const call = heardCall('Blue Jay', 0.3, T);
        hear(call);
        ingest.flush(call.receivedAt + SETTLE_MS);
        assert.equal(visits().length, 1);
        assert.equal(store.getVisit('old').tier, undefined, 'it is not rated after the fact');
        assert.equal(store.getVisit('old').firstEver, true);
        assert.deepEqual(events, []);
    });
});

test('a second opinion that was heard first becomes the main model\'s visit when v3.0 speaks later: one visit, renamed, not two', async () => {
    await withHarness(({ store, hear, ingest, events, visits }) => {
        v3IsRunning(store);
        const perch = heardCall('Fish Crow', 0.7, T, { model: 'perch', received: T + 15_000 });
        hear(perch);
        ingest.flush(perch.receivedAt + SECOND_OPINION_SETTLE_MS);
        assert.equal(visits().filter(visit => visit.tier).length, 1);
        assert.equal(visits().find(visit => visit.tier).species, 'Fish Crow');
        const v3 = heardCall('American Crow', 0.85, T + 1_000, { model: 'v3', received: perch.receivedAt + SECOND_OPINION_SETTLE_MS + 3_000 });
        hear(v3);
        ingest.flush(v3.receivedAt + SETTLE_MS);
        const rated = visits().filter(visit => visit.tier);
        assert.equal(rated.length, 1, 'still one visit for that moment');
        const [visit] = rated;
        assert.equal(visit.species, 'American Crow');
        assert.equal(visit.score, 0.85);
        assert.equal(visit.tier, 'check');
        assert.deepEqual(visit.tierWhy, ['models_disagree']);
        assert.deepEqual(visit.models.map(item => [item.model, item.species, item.role]), [['birdnet_v3', 'American Crow', 'named'], ['perch_v2', 'Fish Crow', 'other']]);
        assert.deepEqual(visit.suggestions[0], { species: 'Fish Crow', why: 'model' });
        assert.deepEqual(visit.audio, { birdnetDetectionId: v3.detectionId, birdnetClip: 'American Crow.opus' });
        assert.deepEqual(events.map(([type]) => type), ['visit_new', 'visit_updated']);
        assert.equal(store.hasSpecies('Fish Crow'), false);
    });
});

test('calls of an unwatched camera make no visit; a call outside the pairing window is a separate moment', async () => {
    await withHarness(({ hear, settle, visits }) => {
        hear(heardCall('Blue Jay', 0.9, T, { camera: '999' }));
        settle();
        assert.equal(visits().length, 0);
    });
    await withHarness(({ store, hear, settle, visits }) => {
        v3IsRunning(store);
        hear(heardCall('Blue Jay', 0.9, T, { model: 'v3' }), heardCall('American Crow', 0.8, T + PAIR_WINDOW_MS + 5_000, { model: 'perch', received: T + 15_000 }));
        settle();
        const rated = visits().filter(visit => visit.tier);
        assert.equal(rated.length, 2, 'two different moments, two visits');
        assert.equal(rated.find(visit => visit.species === 'Blue Jay').tier, 'likely');
        assert.equal(rated.find(visit => visit.species === 'American Crow').tier, 'check');
    });
});

// --- how the tier meets the camera ----------------------------------------------------------------

function savedSighting(store, id, species) {
    store.saveVisit({
        id, camera: { id: '88', name: 'Backyard Camera' }, kind: 'seen', startedAt: T, species, grp: 'mammal', status: 'auto', score: 0.9,
        snapshot: `media/snap/${id}.jpg`, crop: `media/crop/${id}.jpg`, clip: { state: 'none', expectedReadyAt: null }, heard: null, audio: null,
        suggestions: [], firstEver: false, muted: false, notify: true,
    });
}

test('a Likely call links to the camera sighting of the same bird', async () => {
    await withHarness(({ store, hear, settle, visits }) => {
        savedSighting(store, 'seen-raccoon', 'Common Raccoon');
        hear(heardCall('Common Raccoon', 0.9, T + 10_000, { grp: 'mammal' }));
        settle();
        const [heard] = visits();
        assert.equal(heard.tier, 'likely');
        assert.equal(store.getVisit('seen-raccoon').heard.visitId, heard.id);
        assert.equal(store.getVisit('seen-raccoon').review, false);
    });
});

test('a Possible call neither links to a sighting nor puts one on the review list, while a Likely call of another animal does', async () => {
    await withHarness(({ store, hear, settle, visits }) => {
        v3IsRunning(store);
        knownSpecies(store, 'Barred Owl');
        savedSighting(store, 'seen-squirrel', 'Eastern Gray Squirrel');
        hear(heardCall('Barred Owl', 0.55, T + 20_000));
        settle();
        const owl = visits().find(visit => visit.tier);
        assert.equal(owl.tier, 'possible');
        assert.equal(owl.review, false);
        assert.equal(store.getVisit('seen-squirrel').review, false, 'a call that may be nothing is no reason to doubt the camera');
        assert.equal(store.getVisit('seen-squirrel').heard, null);
        hear(heardCall('Barred Owl', 0.95, T + 40_000, { camera: '88' }));
        settle();
        assert.equal(store.getVisit(owl.id).tier, 'likely', 'a confident repeat promotes the owl');
        assert.equal(store.getVisit('seen-squirrel').review, true, 'now a sighting and a call of different animals at the same moment need a person to look');
    });
});

test('a second opinion never goes ahead of a main-model call for the same moment that is still waiting', async () => {
    await withHarness(({ hear, ingest, events, visits }) => {
        const perch = heardCall('American Crow', 0.61, T + 2_000, { model: 'perch', received: T + 15_000 });
        const v3 = heardCall('Blue Jay', 0.82, T, { model: 'v3', received: T + 16_500 });
        hear(perch, v3);
        // Perch was received first, before anything proved v3.0 is running, so its own wait is the short one: it is due
        // first. v3.0's message is already in, so it is the main model and Perch must not make a visit of its own.
        ingest.flush(perch.receivedAt + SETTLE_MS);
        assert.deepEqual(events, []);
        ingest.flush(v3.receivedAt + SETTLE_MS);
        assert.deepEqual(events, [['visit_new', 'visit-1']]);
        ingest.flush(v3.receivedAt + SECOND_OPINION_SETTLE_MS + 5_000);
        assert.equal(visits().length, 1);
        assert.equal(visits()[0].species, 'Blue Jay');
        assert.equal(visits()[0].tier, 'check');
        assert.deepEqual(events, [['visit_new', 'visit-1']], 'one announcement, the disagreement was known before it');
    });
});

test('a message that makes no call (an insect) still shows which model is running, so Perch is the second opinion from then on', async () => {
    await withHarness(({ ingest, hear, settle, visits }) => {
        ingest.noteModel('birdnet_v3', 3, T);
        hear(heardCall('Dunlin', 0.9, T, { model: 'perch' }));
        settle();
        const [visit] = visits();
        assert.equal(visit.tier, 'check');
        assert.deepEqual(visit.tierWhy, ['second_opinion_only', 'new_here']);
        assert.equal(visit.notify, false, 'a first-ever species heard only by the second opinion is not announced');
    });
});

test('real BirdNET-Go 20260823 messages (captured 2026-10-03) carry the model as a nested object and an occurrence', () => {
    const perch = { Date: '2026-10-03', Time: '21:41:37', Model: { Name: 'Perch', Version: 'V2', Variant: 'default', ClassifierPath: null, ModelType: '' }, CommonName: 'Great Horned Owl', Confidence: 0.78, occurrence: 0.5629528760910034, sourceName: 'Backyard Camera' };
    const v3 = { Date: '2026-10-03', Time: '22:07:33', Model: { Name: 'BirdNET', Version: '3.0', Variant: 'default', ClassifierPath: null, ModelType: '' }, CommonName: 'Japanese Burrowing Cricket', Confidence: 0.71, occurrence: 0.066, sourceName: 'Back Door Camera' };
    assert.equal(modelOf(perch).key, 'perch_v2');
    assert.equal(occurrenceOf(perch), 0.5629528760910034);
    assert.equal(modelOf(v3).key, 'birdnet_v3');
    assert.equal(occurrenceOf(v3), 0.066);
});

// --- BirdNET-Go's unlikely tag, through the ingest ---------------------------------------------------

test('a clear call BirdNET-Go tagged unlikely is kept as a Check visit for a person to look at: not counted, not announced as news, in the review list', async () => {
    await withHarness(({ store, hear, settle, visits, events }) => {
        hear(heardCall('Blue Jay', 0.95, T, { unlikely: true }));
        settle();
        const [visit] = visits();
        assert.equal(visit.unlikely, true);
        assert.equal(visit.tier, 'check');
        assert.deepEqual(visit.tierWhy, ['birdnet_unlikely']);
        assert.equal(visit.review, true);
        assert.equal(visit.notify, false);
        assert.equal(visit.firstEver, false);
        assert.deepEqual(store.listReview().map(item => item.id), [visit.id]);
        assert.equal(store.speciesList().length, 0, 'a call BirdNET-Go doubts adds nothing to the species list');
        assert.deepEqual(events, [['visit_new', visit.id]]);
        assert.equal(store.getVisit(visit.id).unlikely, true, 'and it is still there after being read back from the database');
    });
});

test('the unlikely tag stays while every call of the visit has it and clears when a later call of the bird is not tagged, the way BirdNET-Go merges its own hits', async () => {
    await withHarness(({ hear, ingest, visits, events }) => {
        const first = heardCall('Scarlet Tanager', 0.9, T, { unlikely: true });
        hear(first);
        ingest.flush(first.receivedAt + SETTLE_MS);
        const again = heardCall('Scarlet Tanager', 0.9, T + 20_000, { unlikely: true });
        hear(again);
        ingest.flush(again.receivedAt + SETTLE_MS);
        let [visit] = visits();
        assert.equal(visits().length, 1, 'the same bird inside the cooldown is the same visit');
        assert.equal(visit.repeats, 1);
        assert.equal(visit.unlikely, true, 'every call of it is tagged');
        assert.equal(visit.tier, 'check');
        assert.deepEqual(visit.tierWhy, ['birdnet_unlikely']);
        assert.deepEqual(events, [['visit_new', 'visit-1']], 'a tagged repeat is saved quietly');
        const plain = heardCall('Scarlet Tanager', 0.9, T + 40_000);
        hear(plain);
        ingest.flush(plain.receivedAt + SETTLE_MS);
        [visit] = visits();
        assert.equal(visit.unlikely, false, 'a call BirdNET-Go did not tag clears it');
        assert.equal(visit.tier, 'likely');
        assert.deepEqual(visit.tierWhy, ['strong', 'repeated']);
        assert.equal(visit.review, false, 'it left the review queue by itself');
        assert.deepEqual(events, [['visit_new', 'visit-1'], ['visit_updated', 'visit-1']]);
    });
});

test('a Likely visit is not taken back by a later tagged call (the tag only holds while every call has it), and one tagged call of a never-tagged bird makes no visit Check', async () => {
    await withHarness(({ hear, ingest, visits, events }) => {
        const first = heardCall('Eastern Towhee', 0.9, T);
        hear(first);
        ingest.flush(first.receivedAt + SETTLE_MS);
        const tagged = heardCall('Eastern Towhee', 0.9, T + 20_000, { unlikely: true });
        hear(tagged);
        ingest.flush(tagged.receivedAt + SETTLE_MS);
        const [visit] = visits();
        assert.notEqual(visit.unlikely, true);
        assert.equal(visit.tier, 'likely');
        assert.deepEqual(events, [['visit_new', 'visit-1']]);
    });
});

test('when the other model\'s call of the same bird is not tagged, the visit is not tagged either; when both are, it is', async () => {
    for (const [perchTagged, expected] of [[false, 'likely'], [true, 'check']]) {
        await withHarness(({ store, hear, settle, visits }) => {
            v3IsRunning(store);
            knownSpecies(store, 'Wood Thrush');
            hear(heardCall('Wood Thrush', 0.9, T, { model: 'v3', unlikely: true }), heardCall('Wood Thrush', 0.8, T + 1_000, { model: 'perch', unlikely: perchTagged }));
            settle();
            const [visit] = visits().filter(item => item.tier);
            assert.equal(visit.tier, expected, `perch tagged: ${perchTagged}`);
            assert.equal(visit.unlikely === true, perchTagged);
        });
    }
});

test('a call of a visit that was kept before the tag existed has no tag, and a retarget takes the tag of the call that renamed it', async () => {
    await withHarness(({ store, hear, ingest, visits }) => {
        v3IsRunning(store);
        const perch = heardCall('Fish Crow', 0.7, T, { model: 'perch', received: T + 15_000, unlikely: true });
        hear(perch);
        ingest.flush(perch.receivedAt + SECOND_OPINION_SETTLE_MS);
        assert.equal(visits().find(visit => visit.tier).unlikely, true);
        const v3 = heardCall('American Crow', 0.85, T + 1_000, { model: 'v3', received: perch.receivedAt + SECOND_OPINION_SETTLE_MS + 3_000 });
        hear(v3);
        ingest.flush(v3.receivedAt + SETTLE_MS);
        const [visit] = visits().filter(item => item.tier);
        assert.equal(visit.species, 'American Crow');
        assert.notEqual(visit.unlikely, true, 'v3.0\'s own call was not tagged');
        assert.deepEqual(visit.tierWhy, ['models_disagree']);
    });
});

// --- both models agreeing -----------------------------------------------------------------------------

test('both models naming the same bird is Likely from a 60% call; the 60% floor, the rare-bird rule and the disagreement rule are unchanged', async () => {
    const heardBy = async (calls, { known = true, occurrence = 0.5 } = {}) => {
        let visit;
        await withHarness(({ store, hear, settle, visits }) => {
            v3IsRunning(store);
            if (known) knownSpecies(store, 'Wood Thrush');
            hear(...calls.map(([score, model, species = 'Wood Thrush']) => heardCall(species, score, T + (model === 'perch' ? 1_000 : 0), { model, occurrence })));
            settle();
            visit = visits().find(item => item.tier);
        });
        return visit;
    };
    const both = await heardBy([[0.65, 'v3'], [0.72, 'perch']]);
    assert.equal(both.tier, 'likely');
    assert.deepEqual(both.tierWhy, ['models_agree']);
    assert.deepEqual(both.models.map(item => [item.model, item.species, item.role]), [['birdnet_v3', 'Wood Thrush', 'named'], ['perch_v2', 'Wood Thrush', 'agree']]);
    assert.equal(both.repeats, 0);
    assert.equal(both.review, false);
    const alone = await heardBy([[0.65, 'v3']]);
    assert.equal(alone.tier, 'possible', 'the same call heard by v3.0 alone is only Possible');
    assert.deepEqual(alone.tierWhy, ['weak']);
    const faint = await heardBy([[0.55, 'v3'], [0.9, 'perch']]);
    assert.equal(faint.tier, 'possible', 'the main model\'s own score decides: under 60% is under 60%, whatever the other model says');
    const rare = await heardBy([[0.65, 'v3'], [0.72, 'perch']], { occurrence: 0.05 });
    assert.equal(rare.tier, 'check', 'a rare bird still needs three calls');
    assert.deepEqual(rare.tierWhy, ['rare_here']);
    const disagree = await heardBy([[0.8, 'v3'], [0.7, 'perch', 'American Crow']]);
    assert.equal(disagree.tier, 'check');
    assert.deepEqual(disagree.tierWhy, ['models_disagree']);
});

// --- what BirdNET-Go's record of a detection says each model heard ----------------------------------------

const contributions = (v3 = { hitCount: 3, maxConfidence: 0.71 }, perch = { hitCount: 3, maxConfidence: 0.93 }) => [
    { modelName: 'BirdNET', modelVersion: '3.0', modelType: 'birdnet', ...v3 },
    { modelName: 'Perch', modelVersion: 'V2', ...perch },
];

test('a Perch call v3.0 also heard (BirdNET-Go\'s detection record says so) becomes "both models agreed": announced once, saying it again changes nothing', async () => {
    await withHarness(({ store, hear, settle, visits, ingest, events }) => {
        v3IsRunning(store);
        knownSpecies(store, 'Killdeer');
        const call = heardCall('Killdeer', 0.93, T, { model: 'perch' });
        hear(call);
        settle();
        let [visit] = visits().filter(item => item.tier);
        assert.equal(visit.tier, 'possible', 'by the message alone only the second opinion heard it');
        assert.deepEqual(visit.tierWhy, ['second_opinion_only']);
        events.length = 0;
        assert.equal(ingest.recordContributions(visit.id, call.detectionId, contributions(), T + 60_000), 'updated');
        [visit] = visits().filter(item => item.tier);
        assert.deepEqual(visit.models.map(item => [item.model, item.species, item.role, item.score]), [['perch_v2', 'Killdeer', 'named', 0.93], ['birdnet_v3', 'Killdeer', 'agree', 0.71]]);
        assert.equal(visit.tier, 'likely', 'v3.0\'s own 71% plus Perch agreeing');
        assert.deepEqual(visit.tierWhy, ['models_agree']);
        assert.equal(visit.review, false);
        assert.deepEqual(events, [['visit_updated', visit.id]]);
        assert.equal(store.getVisit(visit.id).tier, 'likely', 'and it is saved');
        assert.equal(ingest.recordContributions(visit.id, call.detectionId, contributions(), T + 61_000), 'unchanged');
        assert.deepEqual(events, [['visit_updated', visit.id]], 'nothing more is announced');
        assert.equal(store.getVisit(visit.id).models.length, 2);
    });
});

test('model contributions: a model that did not hear it, an unrated source and a score on a 0-100 scale are all handled; a faint v3.0 hit does not make a Likely call', async () => {
    await withHarness(({ store, hear, settle, visits, ingest }) => {
        v3IsRunning(store);
        knownSpecies(store, 'Killdeer');
        const call = heardCall('Killdeer', 0.93, T, { model: 'perch' });
        hear(call);
        settle();
        const [visit] = visits().filter(item => item.tier);
        const silent = [{ modelName: 'BirdNET', modelVersion: '3.0', hitCount: 0, maxConfidence: 0 }, { modelName: 'Perch', modelVersion: 'V2', hitCount: 2, maxConfidence: 0.93 }];
        assert.equal(ingest.recordContributions(visit.id, call.detectionId, silent, T + 60_000), 'unchanged', 'a model that ran but did not hear it adds nothing');
        const unrated = [{ modelName: 'Some Custom Model', modelVersion: '1', hitCount: 4, maxConfidence: 0.9 }];
        assert.equal(ingest.recordContributions(visit.id, call.detectionId, unrated, T + 60_000), 'unchanged', 'an unrated source is no model agreeing');
        assert.equal(ingest.recordContributions(visit.id, call.detectionId, [{ modelName: 'BirdNET', modelVersion: '3.0', hitCount: 1, maxConfidence: 41 }], T + 60_000), 'updated');
        const after = store.getVisit(visit.id);
        assert.equal(after.models.find(item => item.model === 'birdnet_v3').score, 0.41, '41 on a 0-100 scale is 41%');
        assert.equal(after.tier, 'possible', 'v3.0 at 41% is not a good call, so agreeing alone does not make it Likely');
        assert.deepEqual(after.tierWhy, ['weak']);
    });
});

test('model contributions leave alone a visit that is about another detection, one a person decided, and anything that is not a heard visit; unknown ids are reported', async () => {
    await withHarness(({ store, hear, settle, visits, ingest }) => {
        v3IsRunning(store);
        knownSpecies(store, 'Killdeer');
        const call = heardCall('Killdeer', 0.93, T, { model: 'perch' });
        hear(call);
        settle();
        const [visit] = visits().filter(item => item.tier);
        assert.equal(ingest.recordContributions(visit.id, call.detectionId + 1, contributions(), T + 60_000), 'stale', 'the visit is about a different detection');
        assert.equal(ingest.recordContributions('no-such-visit', call.detectionId, contributions(), T + 60_000), 'unknown');
        assert.equal(ingest.recordContributions('known-Killdeer', 0, contributions(), T + 60_000), 'stale', 'a visit without a BirdNET-Go detection');
        assert.equal(store.getVisit(visit.id).models.length, 1, 'nothing was added');
        store.saveVisit({ ...store.getVisit(visit.id), status: 'confirmed' });
        assert.equal(ingest.recordContributions(visit.id, call.detectionId, contributions(), T + 60_000), 'stale', 'a person already decided it');
        assert.equal(store.getVisit(visit.id).models.length, 1);
        assert.equal(store.getVisit(visit.id).status, 'confirmed');
    });
    await withHarness(({ store, ingest }) => {
        savedSighting(store, 'seen-raccoon', 'Common Raccoon');
        assert.equal(ingest.recordContributions('seen-raccoon', 1, contributions(), T), 'unknown', 'a camera sighting has no models to hear');
    });
});

test('model contributions never relax the rare-bird rule, and never lift an unlikely call out of Check', async () => {
    await withHarness(({ store, hear, settle, visits, ingest }) => {
        v3IsRunning(store);
        knownSpecies(store, 'Killdeer');
        const call = heardCall('Killdeer', 0.93, T, { model: 'perch', occurrence: 0.05 });
        hear(call);
        settle();
        const [visit] = visits().filter(item => item.tier);
        assert.equal(ingest.recordContributions(visit.id, call.detectionId, contributions(), T + 60_000), 'updated');
        const after = store.getVisit(visit.id);
        assert.equal(after.tier, 'check', 'a bird that is rare here still needs more than one call');
        assert.ok(after.tierWhy.includes('rare_here'));
    });
    await withHarness(({ store, hear, settle, visits, ingest }) => {
        v3IsRunning(store);
        knownSpecies(store, 'Killdeer');
        const call = heardCall('Killdeer', 0.93, T, { model: 'perch', unlikely: true });
        hear(call);
        settle();
        const [visit] = visits().filter(item => item.tier);
        assert.deepEqual(visit.tierWhy, ['birdnet_unlikely']);
        assert.equal(ingest.recordContributions(visit.id, call.detectionId, contributions(), T + 60_000), 'updated', 'the models are recorded');
        const after = store.getVisit(visit.id);
        assert.deepEqual(after.models.map(item => item.model), ['perch_v2', 'birdnet_v3']);
        assert.equal(after.tier, 'check');
        assert.deepEqual(after.tierWhy, ['birdnet_unlikely']);
    });
});
