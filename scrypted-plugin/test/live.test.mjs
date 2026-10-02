import assert from 'node:assert/strict';
import test from 'node:test';
import { LIVE_PICTURE_TTL_MS, LivePictureCache, etagFor, etagMatches } from '../src/live.ts';

// A controllable world: a clock, and cameras that can be told to answer, fail, hang or throw.
function world({ cameras = ['106', '108'], ...options } = {}) {
    let clock = 1_000_000;
    const starts = [];                      // [cameraId, clock] for every capture that was started
    const failures = [];
    const behaviour = new Map();            // cameraId -> () => Promise<Buffer> (or throws)
    const source = {
        capture: cameraId => {
            starts.push([cameraId, clock]);
            return (behaviour.get(cameraId) ?? (async () => Buffer.from(`picture ${starts.length}`)))();
        },
        isCamera: cameraId => cameras.includes(cameraId),
        onFailure: (cameraId, error, count, retryInMs) => failures.push({ cameraId, count, retryInMs, message: String(error?.message ?? error) }),
    };
    const cache = new LivePictureCache(source, { now: () => clock, ...options });
    return {
        cache, starts, failures, behaviour,
        calls: cameraId => starts.filter(([id]) => id === cameraId).length,
        tick: ms => { clock += ms; },
        now: () => clock,
    };
}

const nextTurn = () => new Promise(resolve => setImmediate(resolve));

// --- one capture for everyone who asks at the same time ---------------------------------------------

test('requests that arrive while a picture is being taken share that one capture', async () => {
    const w = world();
    let answer;
    w.behaviour.set('106', () => new Promise(resolve => { answer = () => resolve(Buffer.from('the picture')); }));

    const requests = Array.from({ length: 5 }, () => w.cache.get('106'));
    await nextTurn();
    assert.equal(w.calls('106'), 1, 'five requests, one capture');
    answer();
    const pictures = await Promise.all(requests);
    assert.equal(w.calls('106'), 1);
    assert.ok(pictures[0], 'they all got a picture');
    assert.ok(pictures.every(picture => picture === pictures[0]), 'and it is the same picture');

    // A late sixth request is served from memory, not by another capture.
    assert.equal(await w.cache.get('106'), pictures[0]);
    assert.equal(w.calls('106'), 1);
});

test('one camera taking its time never holds up another', async () => {
    const w = world({ deadlineMs: 50 });
    w.behaviour.set('106', () => new Promise(() => {}));        // never answers
    void w.cache.get('106');
    const other = await w.cache.get('108');
    assert.ok(other, 'camera 108 answered while 106 was still pending');
    assert.equal(w.calls('106'), 1);
    assert.equal(w.calls('108'), 1);
});

// --- a camera is asked at most once per 15 s ------------------------------------------------------------

test('a picture is reused for 15 s counted from when its capture started, then replaced', async () => {
    const w = world();
    w.behaviour.set('106', async () => { w.tick(400); return Buffer.from(`taken at ${w.now()}`); });    // taking it takes 0.4 s
    const first = await w.cache.get('106');                     // started at t, finished at t + 0.4 s
    assert.equal(first.capturedAt, w.now(), 'it is stamped with the moment the capture finished');

    w.tick(14_000);                                             // t + 14.4 s
    assert.equal(await w.cache.get('106'), first);
    w.tick(500);                                                // t + 14.9 s
    assert.equal(await w.cache.get('106'), first);
    assert.equal(w.calls('106'), 1, 'still the one capture');

    w.tick(100);                                                // t + 15.0 s
    const second = await w.cache.get('106');
    assert.equal(w.calls('106'), 2, 'asked again exactly when the 15 s are up, so a client that polls every 16 s sees a new picture each time');
    assert.notEqual(second, first);
    assert.notEqual(second.etag, first.etag);
});

test('a slow capture still counts as current for 2 s after it finished', async () => {
    const w = world();
    w.behaviour.set('106', async () => { w.tick(20_000); return Buffer.from('slow camera'); });        // 20 s to answer
    const first = await w.cache.get('106');
    w.tick(1_900);
    assert.equal(await w.cache.get('106'), first, 'not thrown away the moment it arrives');
    w.tick(200);
    await w.cache.get('106');
    assert.equal(w.calls('106'), 2);
});

test('hammering one camera never starts captures closer together than 15 s', async () => {
    const w = world();
    for (let second = 0; second < 120; second++) {
        await w.cache.get('106');                               // a request every second for two minutes
        w.tick(1_000);
    }
    const starts = w.starts.filter(([id]) => id === '106').map(([, at]) => at);
    assert.ok(starts.length >= 8 && starts.length <= 9, `about one every 15 s, not one per request (${starts.length})`);
    for (let i = 1; i < starts.length; i++)
        assert.ok(starts[i] - starts[i - 1] >= LIVE_PICTURE_TTL_MS, `captures ${i - 1} and ${i} are ${starts[i] - starts[i - 1]} ms apart`);
});

// --- memory is bounded by the number of cameras -------------------------------------------------------------

test('only cameras that exist are captured or remembered, so a client cannot grow the cache', async () => {
    const w = world({ cameras: ['a', 'b', 'c', 'd'] });
    for (let i = 0; i < 1000; i++) assert.equal(await w.cache.get(`ghost-${i}`), undefined);
    assert.equal(w.starts.length, 0, 'no camera was asked about a made-up id');
    assert.equal(w.cache.size, 0);

    for (let i = 0; i < 400; i++) {
        await w.cache.get(['a', 'b', 'c', 'd'][i % 4]);
        await w.cache.get(`ghost-${i}`);
        w.tick(1_000);
    }
    assert.ok(w.cache.size <= 4, `at most one entry per camera (${w.cache.size})`);
});

// --- the picture's validators ----------------------------------------------------------------------------------

test('the ETag is a quoted fingerprint of the bytes, the same for the same picture', async () => {
    const w = world();
    w.behaviour.set('106', async () => Buffer.from('an unchanging scene'));
    const first = await w.cache.get('106');
    assert.match(first.etag, /^"[0-9a-f]{24}"$/);
    assert.equal(first.etag, etagFor(Buffer.from('an unchanging scene')));
    w.tick(16_000);
    const second = await w.cache.get('106');
    assert.notEqual(second, first, 'a new capture');
    assert.equal(second.etag, first.etag, 'but the same bytes, so the same ETag (a client holding the old one can be told "unchanged")');
    assert.notEqual(etagFor(Buffer.from('a different scene')), first.etag);
});

test('If-None-Match matches the current ETag, a list containing it, a weak copy of it, or *', () => {
    const etag = etagFor(Buffer.from('x'));
    assert.equal(etagMatches(etag, etag), true);
    assert.equal(etagMatches(`"other", ${etag}`, etag), true, 'one of several');
    assert.equal(etagMatches(`W/${etag}`, etag), true, 'weak comparison');
    assert.equal(etagMatches('*', etag), true);
    assert.equal(etagMatches('"other"', etag), false);
    assert.equal(etagMatches('', etag), false);
    assert.equal(etagMatches(undefined, etag), false);
});

// --- a camera that cannot answer is left alone --------------------------------------------------------------

test('a failing camera is asked again after 15 s, then 30 s, then 60 s at most, and one success resets it', async () => {
    const w = world();
    let working = false;
    w.behaviour.set('106', async () => { if (!working) throw new Error('camera offline'); return Buffer.from('back online'); });

    assert.equal(await w.cache.get('106'), undefined, 'a failure is an answer of "nothing": the caller falls back');
    assert.deepEqual(w.failures.map(({ count, retryInMs }) => [count, retryInMs]), [[1, 15_000]]);
    assert.match(w.failures[0].message, /camera offline/);

    const attempt = async (afterMs, expectedAttempts) => {
        w.tick(afterMs);
        await w.cache.get('106');
        assert.equal(w.calls('106'), expectedAttempts, `${afterMs} ms later`);
    };
    await attempt(14_999, 1);                        // still inside the 15 s
    await attempt(1, 2);                             // 15 s: second attempt, fails -> next wait 30 s
    await attempt(29_999, 2);
    await attempt(1, 3);                             // fails -> next wait 60 s
    await attempt(59_999, 3);
    await attempt(1, 4);                             // fails -> still 60 s (the cap)
    await attempt(59_999, 4);
    assert.deepEqual(w.failures.map(({ retryInMs }) => retryInMs), [15_000, 30_000, 60_000, 60_000]);

    working = true;
    w.tick(1);
    const picture = await w.cache.get('106');
    assert.ok(picture, 'answers again as soon as it is asked after the wait');
    assert.equal(w.calls('106'), 5);

    working = false;
    w.tick(16_000);
    assert.equal(await w.cache.get('106'), undefined);
    assert.equal(w.failures.at(-1).retryInMs, 15_000, 'after a success the waits start again from 15 s');
});

test('a camera that never answers is given up on at the deadline, left alone afterwards, and a late answer is ignored', async () => {
    const w = world({ deadlineMs: 30 });
    let lateAnswer;
    w.behaviour.set('106', () => new Promise(resolve => { lateAnswer = resolve; }));

    const asked = Date.now();
    assert.equal(await w.cache.get('106'), undefined);
    assert.ok(Date.now() - asked >= 25, 'it waited for the deadline');
    assert.match(w.failures[0].message, /no answer within 30 ms/);

    assert.equal(await w.cache.get('106'), undefined);
    assert.equal(w.calls('106'), 1, 'not asked again while it is being left alone, so hung calls cannot pile up');

    lateAnswer(Buffer.from('far too late'));
    await nextTurn();
    assert.equal(await w.cache.get('106'), undefined, 'the late answer did not resurrect an old picture');

    w.behaviour.set('106', async () => Buffer.from('answering now'));
    w.tick(15_000);
    assert.ok(await w.cache.get('106'), 'asked again once the wait is over');
    assert.equal(w.calls('106'), 2);
});

test('a camera that throws at once, or sends an empty picture, fails cleanly and is not wedged', async () => {
    const w = world();
    w.behaviour.set('106', () => { throw new Error('threw before returning a promise'); });
    assert.equal(await w.cache.get('106'), undefined);
    w.behaviour.set('108', async () => Buffer.alloc(0));
    assert.equal(await w.cache.get('108'), undefined);
    assert.deepEqual(w.failures.map(failure => failure.cameraId).sort(), ['106', '108']);
    assert.match(w.failures.find(failure => failure.cameraId === '108').message, /empty picture/);

    w.behaviour.delete('106');
    w.tick(15_000);
    assert.ok(await w.cache.get('106'), 'asked again later and works: nothing was left registered as "in flight"');
});

test('a failure report that throws does not turn the failure into a different one', async () => {
    const cache = new LivePictureCache({
        capture: async () => { throw new Error('camera offline'); },
        isCamera: () => true,
        onFailure: () => { throw new Error('the logger broke'); },
    });
    assert.equal(await cache.get('106'), undefined);
});

test('clear forgets every picture', async () => {
    const w = world();
    await w.cache.get('106');
    await w.cache.get('108');
    assert.equal(w.cache.size, 2);
    w.cache.clear();
    assert.equal(w.cache.size, 0);
    await w.cache.get('106');
    assert.equal(w.calls('106'), 2, 'a fresh capture after clearing');
});
