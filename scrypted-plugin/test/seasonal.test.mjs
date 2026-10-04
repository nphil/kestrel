import assert from 'node:assert/strict';
import test from 'node:test';
import { SEASONAL_PRIOR } from '../src/seasonal-prior.ts';
import { MIN_SIGHTINGS, RARE_COMMONNESS, commonnessFor, quarterMonthIndex } from '../src/seasonal.ts';

const JAN_10 = Date.parse('2026-01-10T17:00:00Z');   // Jan 8-14 -> bin 1
const JUL_10 = Date.parse('2026-07-10T17:00:00Z');   // Jul 8-14 -> bin 25

// A table where only the July bin is in season, so any answer is traceable to the bin.
const julyOnly = Array.from({ length: 48 }, (_, i) => (i === 25 ? 90 : 0));
const table = {
    'archilochus colubris': { obs: 400, pct: julyOnly },
    'thin species': { obs: MIN_SIGHTINGS - 1, pct: julyOnly },
    'felis catus': { obs: 0, always: true, pct: Array(48).fill(100) },
    'strix varia': { obs: 600, pct: julyOnly },
};

test('quarter-month bins follow the local Atlanta date, not UTC', () => {
    assert.equal(quarterMonthIndex(Date.parse('2026-01-01T12:00:00Z')), 0);
    assert.equal(quarterMonthIndex(Date.parse('2026-01-08T12:00:00Z')), 1);
    assert.equal(quarterMonthIndex(Date.parse('2026-01-31T12:00:00Z')), 3);
    assert.equal(quarterMonthIndex(Date.parse('2026-02-28T12:00:00Z')), 7);
    // 03:00 UTC on Jan 1 is still 10 pm Dec 31 in Atlanta.
    assert.equal(quarterMonthIndex(Date.parse('2026-01-01T03:00:00Z')), 47);
    // Daylight time: 02:30 UTC Jul 8 is 10:30 pm Jul 7 in Atlanta, the previous bin.
    assert.equal(quarterMonthIndex(Date.parse('2026-07-08T02:30:00Z')), 24);
});

test('a well-recorded species is common in season and rare out of it', () => {
    assert.equal(commonnessFor(table, 'Archilochus colubris', JUL_10), 0.9);
    assert.ok(commonnessFor(table, 'Archilochus colubris', JAN_10) < RARE_COMMONNESS);
});

test('a species absent from the table scores 0 year-round', () => {
    assert.equal(commonnessFor(table, 'Calidris alpina', JUL_10), 0);
    assert.equal(commonnessFor(table, 'Calidris alpina', JAN_10), 0);
});

test('thin evidence is damped toward the middle and never reads as rare', () => {
    const inSeason = commonnessFor(table, 'Thin species', JUL_10);
    const offSeason = commonnessFor(table, 'Thin species', JAN_10);
    assert.ok(inSeason > 0.5 && inSeason < 0.9, `in season ${inSeason}`);
    assert.ok(offSeason >= 0.25 && offSeason > RARE_COMMONNESS, `off season ${offSeason}`);
});

test('owls and nightjars get no opinion, even when unlisted or well recorded', () => {
    assert.equal(commonnessFor(table, 'Strix varia', JAN_10), null);
    assert.equal(commonnessFor(table, 'Bubo scandiacus', JAN_10), null);
    assert.equal(commonnessFor(table, 'Antrostomus carolinensis', JAN_10), null);
});

test('always-present species (domestic cat) score 1', () => {
    assert.equal(commonnessFor(table, 'Felis catus', JAN_10), 1);
});

test('no scientific name means no opinion', () => {
    assert.equal(commonnessFor(table, undefined, JAN_10), null);
    assert.equal(commonnessFor(table, null, JAN_10), null);
    assert.equal(commonnessFor(table, '  ', JAN_10), null);
});

test('names that collide with object built-ins are just unseen species', () => {
    assert.equal(commonnessFor(table, 'constructor', JAN_10), 0);
});

test('bundled table: resident common, migrant seasonal, shorebird unlisted, owl exempt', () => {
    const wren = commonnessFor(SEASONAL_PRIOR, 'Thryothorus ludovicianus', JAN_10);
    assert.ok(wren > 0.5, `wren Jan ${wren}`);
    assert.ok(commonnessFor(SEASONAL_PRIOR, 'Thryothorus ludovicianus', JUL_10) > 0.5);
    assert.ok(commonnessFor(SEASONAL_PRIOR, 'Archilochus colubris', JAN_10) < RARE_COMMONNESS);
    assert.ok(commonnessFor(SEASONAL_PRIOR, 'Archilochus colubris', JUL_10) > 0.5);
    assert.equal(commonnessFor(SEASONAL_PRIOR, 'Calidris alpina', JUL_10), 0);
    assert.equal(commonnessFor(SEASONAL_PRIOR, 'Strix varia', JAN_10), null);
    assert.equal(commonnessFor(SEASONAL_PRIOR, 'Felis catus', JAN_10), 1);
});
