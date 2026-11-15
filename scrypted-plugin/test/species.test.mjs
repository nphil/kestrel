import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { KestrelStore, parseHighlightKind, parseSpeciesPeriod, periodStart, seasonOf } from '../src/store.ts';

// Noon in New York on Saturday 14 November 2026 (standard time, UTC-5). The tests never lean on the machine's own time zone.
const NOW = Date.parse('2026-11-14T17:00:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = iso => Date.parse(iso);

let counter = 0;
function visit(kind, species, startedAt, extra = {}) {
    counter += 1;
    return {
        id: `v${counter}`, camera: { id: '88', name: 'Backyard Camera' }, kind, startedAt, species,
        grp: kind === 'heard' ? 'bird' : 'mammal', status: 'auto', score: 0.8,
        snapshot: null, crop: null, clip: { state: 'none', expectedReadyAt: null }, heard: null, audio: null,
        suggestions: [], firstEver: false, muted: false, notify: false, ...extra,
    };
}

async function withStore(run) {
    const directory = await mkdtemp(join(tmpdir(), 'kestrel-species-test-'));
    const store = new KestrelStore(join(directory, 'kestrel.sqlite'));
    try {
        await run(store);
    } finally {
        store.close();
        await rm(directory, { recursive: true, force: true });
    }
}

test('a period starts at a New York midnight, counting today as the first day', () => {
    assert.equal(periodStart('all', NOW), null);
    assert.equal(periodStart('today', NOW), at('2026-11-14T05:00:00Z'));
    assert.equal(periodStart('week', NOW), at('2026-11-08T05:00:00Z'));
    // Thirty days back crosses the end of daylight time: 16 October midnight is still UTC-4.
    assert.equal(periodStart('month', NOW), at('2026-10-16T04:00:00Z'));
    // One second before midnight in New York it is still the day before.
    assert.equal(periodStart('today', at('2026-11-14T04:59:59Z')), at('2026-11-13T05:00:00Z'));
    assert.equal(periodStart('today', at('2026-11-14T05:00:00Z')), at('2026-11-14T05:00:00Z'));
    // The week that holds the spring change of clocks (8 March 2026) still starts at a local midnight.
    assert.equal(periodStart('week', at('2026-03-09T12:00:00Z')), at('2026-03-03T05:00:00Z'));
    assert.equal(periodStart('today', at('2026-03-09T12:00:00Z')), at('2026-03-09T04:00:00Z'));
});

test('a season is a meteorological three months in New York time', () => {
    assert.deepEqual(seasonOf(NOW), { season: 'autumn', start: at('2026-09-01T04:00:00Z') });
    assert.deepEqual(seasonOf(at('2026-01-15T17:00:00Z')), { season: 'winter', start: at('2025-12-01T05:00:00Z') });
    assert.deepEqual(seasonOf(at('2026-12-15T17:00:00Z')), { season: 'winter', start: at('2026-12-01T05:00:00Z') });
    // 1 March begins at midnight in New York, five hours before it does in UTC.
    assert.equal(seasonOf(at('2026-03-01T04:59:59Z')).season, 'winter');
    assert.deepEqual(seasonOf(at('2026-03-01T05:00:00Z')), { season: 'spring', start: at('2026-03-01T05:00:00Z') });
    assert.equal(seasonOf(at('2026-06-01T03:59:59Z')).season, 'spring');
    assert.equal(seasonOf(at('2026-06-01T04:00:00Z')).season, 'summer');
    assert.equal(seasonOf(at('2026-08-31T12:00:00Z')).season, 'summer');
    assert.equal(seasonOf(at('2026-09-01T04:00:00Z')).season, 'autumn');
    assert.equal(seasonOf(at('2026-11-30T12:00:00Z')).season, 'autumn');
});

test('the period and kind a request names are checked, and a missing one means everything', () => {
    assert.equal(parseSpeciesPeriod(null), 'all');
    assert.equal(parseSpeciesPeriod(undefined), 'all');
    assert.equal(parseSpeciesPeriod(''), 'all');
    for (const period of ['today', 'week', 'month', 'all']) assert.equal(parseSpeciesPeriod(period), period);
    assert.throws(() => parseSpeciesPeriod('weeks'), error => error.status === 400 && /today, week, month or all/.test(error.message));
    assert.equal(parseHighlightKind(null), 'both');
    for (const kind of ['seen', 'heard', 'both']) assert.equal(parseHighlightKind(kind), kind);
    assert.throws(() => parseHighlightKind('listened'), error => error.status === 400 && /seen, heard or both/.test(error.message));
});

test('the species list for a period keeps only species with a counted visit in it and counts them', async () => {
    await withStore(async store => {
        store.saveVisit(visit('seen', 'Blue Jay', at('2026-11-14T13:00:00Z')));
        store.saveVisit(visit('heard', 'Blue Jay', at('2026-11-14T04:59:00Z')));   // 23:59 the evening before in New York
        store.saveVisit(visit('heard', 'Carolina Wren', at('2026-11-08T05:00:00Z')));   // the very start of the week
        store.saveVisit(visit('heard', 'Carolina Wren', at('2026-11-08T04:59:59Z')));   // one second before it
        store.saveVisit(visit('heard', 'Barred Owl', at('2026-10-16T04:00:00Z')));   // the very start of the month
        store.saveVisit(visit('seen', 'Red Fox', at('2026-10-16T03:59:59Z')));   // one second before it
        store.saveVisit(visit('heard', 'Wild Turkey', at('2026-11-14T14:00:00Z'), { tier: 'possible' }));   // does not count yet

        const names = period => store.speciesList(period, NOW).map(item => item.species);
        assert.deepEqual(names('all'), ['Blue Jay', 'Carolina Wren', 'Barred Owl', 'Red Fox']);
        assert.deepEqual(names('month'), ['Blue Jay', 'Carolina Wren', 'Barred Owl']);
        assert.deepEqual(names('week'), ['Blue Jay', 'Carolina Wren']);
        assert.deepEqual(names('today'), ['Blue Jay']);
        assert.deepEqual(store.speciesList(undefined, NOW).map(item => item.species), names('all'), 'no period means all');

        const counts = period => Object.fromEntries(store.speciesList(period, NOW).map(item => [item.species, [item.periodCount, item.periodSeen, item.periodHeard]]));
        assert.deepEqual(counts('all'), {
            'Blue Jay': [2, 1, 1], 'Carolina Wren': [2, 0, 2], 'Barred Owl': [1, 0, 1], 'Red Fox': [1, 1, 0],
        });
        assert.deepEqual(counts('month'), { 'Blue Jay': [2, 1, 1], 'Carolina Wren': [2, 0, 2], 'Barred Owl': [1, 0, 1] });
        assert.deepEqual(counts('week'), { 'Blue Jay': [2, 1, 1], 'Carolina Wren': [1, 0, 1] });
        assert.deepEqual(counts('today'), { 'Blue Jay': [1, 1, 0] });

        // Everything but the three period counts stays what it is for all time.
        const [jay] = store.speciesList('today', NOW);
        assert.equal(jay.seen, true);
        assert.equal(jay.heard, true);
        assert.equal(jay.first, at('2026-11-14T04:59:00Z'));
        assert.equal(jay.last, at('2026-11-14T13:00:00Z'));
        assert.equal(jay.count30d, 2);

        assert.deepEqual(store.speciesIndex('week', NOW), { items: store.speciesList('week', NOW), period: 'week', since: at('2026-11-08T05:00:00Z') });
        assert.equal(store.speciesIndex('all', NOW).since, null);
        assert.equal(store.speciesIndex(undefined, NOW).period, 'all');
    });
});

test('a species sheet gets visits per New York day, first and last visit and the surest identification', async () => {
    await withStore(async store => {
        const wren = (id, iso, score, extra = {}) => store.saveVisit(visit('heard', 'Carolina Wren', at(iso), { id, score, ...extra }));
        wren('a', '2026-10-15T20:00:00Z', 0.55);   // the day before the thirty-day window
        wren('b', '2026-10-16T04:00:00Z', 0.7);   // first moment of its first day
        wren('c', '2026-11-14T03:00:00Z', 0.91);   // 22:00 on 13 November in New York
        wren('d', '2026-11-14T04:59:00Z', 0.91);   // 23:59 on 13 November: ties with c, the newer one wins
        wren('e', '2026-11-14T05:00:00Z', 0.6);   // midnight: today
        wren('f', '2026-11-14T15:00:00Z', 0.99, { tier: 'possible' });   // a quiet call counts for nothing

        const insights = store.speciesInsights('Carolina Wren', NOW);
        assert.equal(insights.perDay.length, 30);
        assert.equal(insights.perDayFrom, '2026-10-16');
        const expected = Array(30).fill(0);
        expected[0] = 1;
        expected[28] = 2;
        expected[29] = 1;
        assert.deepEqual(insights.perDay, expected);
        assert.equal(insights.firstAt, at('2026-10-15T20:00:00Z'));
        assert.equal(insights.lastAt, at('2026-11-14T05:00:00Z'));
        assert.equal(insights.bestScore, 0.91);
        assert.equal(insights.bestVisitId, 'd');
        assert.equal(insights.season, 'autumn');
        assert.equal(insights.newToHome, false);
        assert.equal(insights.newThisSeason, false);
        assert.equal(insights.description, null);
        assert.equal(insights.descriptionSource, null);
    });
});

test('an unknown species has empty insights', async () => {
    await withStore(async store => {
        const insights = store.speciesInsights('Nobody', NOW);
        assert.deepEqual(insights.perDay, Array(30).fill(0));
        assert.equal(insights.firstAt, null);
        assert.equal(insights.lastAt, null);
        assert.equal(insights.bestScore, null);
        assert.equal(insights.bestVisitId, null);
        assert.equal(insights.newToHome, false);
        assert.equal(insights.newThisSeason, false);
    });
});

test('new to the home means the first visit ever was within seven days', async () => {
    await withStore(async store => {
        store.saveVisit(visit('seen', 'Snow Goose', NOW - 7 * DAY));
        store.saveVisit(visit('seen', 'Cackling Goose', NOW - 7 * DAY - 1));
        const flags = name => store.speciesInsights(name, NOW).newToHome;
        assert.equal(flags('Snow Goose'), true, 'exactly seven days ago is still new');
        assert.equal(flags('Cackling Goose'), false, 'a millisecond longer is not');
    });
});

test('a heard call that was purged still counts as the first time the species was here', async () => {
    await withStore(async store => {
        store.saveVisit(visit('heard', 'Red-tailed Hawk', at('2026-01-05T15:00:00Z')));
        store.saveVisit(visit('seen', 'Red-tailed Hawk', at('2026-11-12T15:00:00Z')));
        assert.equal(store.purgeHeardBefore(at('2026-02-01T00:00:00Z'), true).removed, 1);
        const insights = store.speciesInsights('Red-tailed Hawk', NOW);
        assert.equal(insights.firstAt, at('2026-01-05T15:00:00Z'));
        assert.equal(insights.newToHome, false);
        assert.equal(insights.lastAt, at('2026-11-12T15:00:00Z'));
    });
});

test('new this season is the first of the season, not a bird that was already around', async () => {
    await withStore(async store => {
        // Autumn began at New York midnight on 1 September. The carry-over window reaches back to 2 August 04:00 UTC.
        store.saveVisit(visit('seen', 'Ruby-throated Hummingbird', at('2026-08-01T15:00:00Z')));   // gone for a month before autumn
        store.saveVisit(visit('seen', 'Ruby-throated Hummingbird', at('2026-11-12T15:00:00Z')));
        store.saveVisit(visit('seen', 'Barn Swallow', at('2026-08-20T15:00:00Z')));   // was around when autumn began
        store.saveVisit(visit('seen', 'Barn Swallow', at('2026-11-12T15:00:00Z')));
        store.saveVisit(visit('seen', 'Eastern Bluebird', at('2026-09-20T15:00:00Z')));   // first of the season, but weeks ago
        store.saveVisit(visit('seen', 'Eastern Bluebird', at('2026-11-13T15:00:00Z')));
        store.saveVisit(visit('seen', 'Dark-eyed Junco', at('2026-11-10T15:00:00Z')));   // never seen before at all

        const flags = name => {
            const { newThisSeason, newToHome } = store.speciesInsights(name, NOW);
            return { newThisSeason, newToHome };
        };
        assert.deepEqual(flags('Ruby-throated Hummingbird'), { newThisSeason: true, newToHome: false });
        assert.deepEqual(flags('Barn Swallow'), { newThisSeason: false, newToHome: false });
        assert.deepEqual(flags('Eastern Bluebird'), { newThisSeason: false, newToHome: false });
        assert.deepEqual(flags('Dark-eyed Junco'), { newThisSeason: true, newToHome: true });
    });
});

// A week of visits shared by the highlights tests. Times are UTC; the week began at 2026-11-08T05:00:00Z.
function fillHighlights(store) {
    const heard = (species, iso) => store.saveVisit(visit('heard', species, at(iso)));
    const seen = (species, iso, extra) => store.saveVisit(visit('seen', species, at(iso), extra));
    for (const iso of ['2026-11-14T12:00:00Z', '2026-11-13T12:00:00Z', '2026-11-12T12:00:00Z', '2026-11-11T12:00:00Z', '2026-11-10T12:00:00Z']) heard('Carolina Wren', iso);
    for (const iso of ['2026-09-01T12:00:00Z', '2026-09-02T12:00:00Z', '2026-09-03T12:00:00Z']) heard('Carolina Wren', iso);
    for (const iso of ['2026-11-13T09:00:00Z', '2026-11-12T09:00:00Z', '2026-11-09T09:00:00Z']) heard('Northern Cardinal', iso);
    heard('Barred Owl', '2026-11-09T03:00:00Z');
    heard('Mourning Dove', '2026-11-12T10:00:00Z');
    for (const iso of ['2026-09-01T10:00:00Z', '2026-09-02T10:00:00Z', '2026-09-03T10:00:00Z', '2026-09-04T10:00:00Z', '2026-09-05T10:00:00Z']) heard('Mourning Dove', iso);
    for (const iso of ['2026-11-10T20:00:00Z', '2026-11-13T02:00:00Z']) seen('Red Fox', iso);
    for (const day of ['08', '09', '10', '11', '12', '13']) seen('Eastern Gray Squirrel', `2026-11-${day}T15:00:00Z`);
    for (let i = 0; i < 14; i++) seen('Eastern Gray Squirrel', `2026-10-${String(i + 1).padStart(2, '0')}T15:00:00Z`);
    seen('Northern Cardinal', '2026-11-14T15:00:00Z');
}

test('highlights name the latest, top and rarest species of a period', async () => {
    await withStore(async store => {
        fillHighlights(store);
        const week = store.highlights('week', 'both', NOW);
        assert.equal(week.period, 'week');
        assert.equal(week.kind, 'both');
        // Newest visit of all: the cardinal seen on the feeder camera, counted with its three calls.
        assert.deepEqual({ ...week.latest, visitId: undefined }, {
            species: 'Northern Cardinal', grp: 'mammal', kind: 'seen', count: 4, total: 4, at: at('2026-11-14T15:00:00Z'), visitId: undefined, hasPhoto: false,
        });
        assert.equal(typeof week.latest.visitId, 'string');
        assert.equal(week.top.species, 'Eastern Gray Squirrel');
        assert.equal(week.top.count, 6);
        assert.equal(week.top.total, 20);
        // The owl and the dove each came once; the owl has never been here any other time.
        assert.equal(week.rare.species, 'Barred Owl');
        assert.equal(week.rare.count, 1);
        assert.equal(week.rare.total, 1);
        assert.equal(week.rare.kind, 'heard');
        assert.equal(week.rare.at, at('2026-11-09T03:00:00Z'));
    });
});

test('the kind of a highlight is chosen before anything is ranked', async () => {
    await withStore(async store => {
        fillHighlights(store);
        const heard = store.highlights('week', 'heard', NOW);
        assert.equal(heard.kind, 'heard');
        assert.equal(heard.latest.species, 'Carolina Wren');
        assert.equal(heard.latest.kind, 'heard');
        assert.equal(heard.latest.at, at('2026-11-14T12:00:00Z'));
        assert.equal(heard.top.species, 'Carolina Wren');
        assert.equal(heard.top.count, 5);
        assert.equal(heard.top.total, 8);
        assert.equal(heard.rare.species, 'Barred Owl');

        const seen = store.highlights('week', 'seen', NOW);
        assert.equal(seen.latest.species, 'Northern Cardinal');
        assert.equal(seen.latest.count, 1, 'its three calls are not counted when only sightings are');
        assert.equal(seen.top.species, 'Eastern Gray Squirrel');
        assert.equal(seen.top.count, 6);
        assert.equal(seen.rare.species, 'Northern Cardinal');
        assert.ok([seen.latest, seen.top, seen.rare].every(item => item.kind === 'seen'));
    });
});

test('a tie for most or least goes to the species seen most recently, then to the one with fewest visits ever', async () => {
    await withStore(async store => {
        const heard = (species, iso) => store.saveVisit(visit('heard', species, at(iso)));
        for (const iso of ['2026-06-01T12:00:00Z', '2026-06-02T12:00:00Z', '2026-06-03T12:00:00Z', '2026-06-04T12:00:00Z']) heard('Carolina Wren', iso);
        heard('Tufted Titmouse', '2026-06-01T12:00:00Z');
        for (const iso of ['2026-06-01T12:00:00Z', '2026-06-02T12:00:00Z']) heard('Carolina Chickadee', iso);
        // Today each came once: the wren last (five visits ever), the titmouse before it (two ever), the chickadee first (three ever).
        heard('Carolina Wren', '2026-11-14T12:00:00Z');
        heard('Tufted Titmouse', '2026-11-14T09:00:00Z');
        heard('Carolina Chickadee', '2026-11-14T07:00:00Z');
        const today = store.highlights('today', 'both', NOW);
        assert.equal(today.latest.species, 'Carolina Wren');
        assert.equal(today.top.species, 'Carolina Wren', 'tied on one visit each: the newer wins');
        assert.equal(today.rare.species, 'Tufted Titmouse', 'tied on one visit each: the one with the fewest visits ever');
        assert.equal(today.rare.total, 2);
    });
});

test('highlights say whether a species has a picture, and are empty when nothing came in the period', async () => {
    await withStore(async store => {
        for (const iso of ['2026-11-12T02:00:00Z', '2026-11-13T02:00:00Z']) {
            const fox = visit('seen', 'Red Fox', at(iso), { snapshot: 'media/snap/fox.jpg' });
            store.saveVisit(fox, { snapshotFile: '/tmp/none/fox.jpg', cropFile: null });
            store.considerSpeciesBest(fox, '/tmp/none/fox.jpg', null);
        }
        store.saveVisit(visit('heard', 'Barred Owl', at('2026-11-13T03:00:00Z')));
        const week = store.highlights('week', 'both', NOW);
        assert.equal(week.latest.species, 'Barred Owl');
        assert.equal(week.top.species, 'Red Fox');
        assert.equal(week.rare.species, 'Barred Owl');
        assert.equal(week.top.hasPhoto, true);
        assert.equal(week.rare.hasPhoto, false);

        const none = store.highlights('today', 'heard', at('2026-11-20T17:00:00Z'));
        assert.deepEqual(none, { period: 'today', kind: 'heard', latest: null, top: null, rare: null });
    });
});
