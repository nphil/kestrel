import assert from 'node:assert/strict';
import test from 'node:test';
import { GPU_FRESH_MS, GpuProbe, RollingAverage, parseGpuStats } from '../src/healthprobes.ts';

const UNKNOWN = { usedMiB: null, totalMiB: null, util: null };
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

// A GPU that can be told to answer, fail, or wait, and a clock that only moves when told to.
function world(options = {}) {
    let clock = 5_000_000;
    const runs = [];
    let behaviour = async () => '16808, 24576, 5\n';
    const probe = new GpuProbe(() => { runs.push(clock); return behaviour(); }, { now: () => clock, ...options });
    return {
        probe, runs,
        behave: next => { behaviour = next; },
        tick: ms => { clock += ms; },
    };
}

// --- reading nvidia-smi's line -----------------------------------------------------------------------

test('a normal line is read as used and total memory (MiB) and utilisation (%)', () => {
    assert.deepEqual(parseGpuStats('16808, 24576, 5\n'), { usedMiB: 16808, totalMiB: 24576, util: 5 });
    assert.deepEqual(parseGpuStats('  0 ,12288,100  '), { usedMiB: 0, totalMiB: 12288, util: 100 });
});

test('with several GPUs the first one is reported', () => {
    assert.deepEqual(parseGpuStats('100, 200, 3\n300, 400, 9\n'), { usedMiB: 100, totalMiB: 200, util: 3 });
    assert.deepEqual(parseGpuStats('100, 200, 3\r\n300, 400, 9\r\n'), { usedMiB: 100, totalMiB: 200, util: 3 });
});

test('anything that is not three numbers is unknown, never a made-up zero', () => {
    for (const output of ['', '\n', 'No devices were found', '[N/A], [N/A], [N/A]', '1, 2', '1, 2, 3, 4', '1, 2,', '1, , 3', '-1, 2, 3', '1, 2, x']) {
        assert.deepEqual(parseGpuStats(output), UNKNOWN, JSON.stringify(output));
    }
});

// --- reading it without holding anything up ---------------------------------------------------------

test('the reading is asynchronous, so a slow GPU stops nothing while it answers', async () => {
    const { probe, behave } = world();
    let answer;
    behave(() => new Promise(resolve => { answer = resolve; }));
    let done = false;
    const asked = probe.stats().then(stats => { done = true; return stats; });
    await nextTurn();
    assert.equal(done, false); // still waiting on nvidia-smi, and this code is running: nothing is blocked
    answer('1, 2, 3');
    assert.deepEqual(await asked, { usedMiB: 1, totalMiB: 2, util: 3 });
});

test('a reading is used again until it is old, then nvidia-smi is asked again', async () => {
    const { probe, runs, tick, behave } = world();
    assert.deepEqual(await probe.stats(), { usedMiB: 16808, totalMiB: 24576, util: 5 });
    tick(GPU_FRESH_MS - 1);
    await probe.stats();
    await probe.stats();
    assert.equal(runs.length, 1);
    behave(async () => '17000, 24576, 40');
    tick(1);
    assert.deepEqual(await probe.stats(), { usedMiB: 17000, totalMiB: 24576, util: 40 });
    assert.equal(runs.length, 2);
});

test('callers that arrive while nvidia-smi is running share that one run', async () => {
    const { probe, runs, behave } = world();
    let answer;
    behave(() => new Promise(resolve => { answer = resolve; }));
    const all = [probe.stats(), probe.stats(), probe.stats()];
    await nextTurn();
    answer('5, 10, 1');
    const results = await Promise.all(all);
    assert.equal(runs.length, 1);
    for (const stats of results) assert.deepEqual(stats, { usedMiB: 5, totalMiB: 10, util: 1 });
});

test('a GPU that cannot be read is remembered as unknown, so no process is started for every request', async () => {
    const { probe, runs, tick, behave } = world();
    behave(async () => { throw Object.assign(new Error('spawn nvidia-smi ENOENT'), { code: 'ENOENT' }); });
    assert.deepEqual(await probe.stats(), UNKNOWN);
    for (let i = 0; i < 20; i += 1) assert.deepEqual(await probe.stats(), UNKNOWN);
    assert.equal(runs.length, 1);
    // ... and it is tried again later, so a GPU that comes back is noticed
    behave(async () => '7, 8, 9');
    tick(GPU_FRESH_MS);
    assert.deepEqual(await probe.stats(), { usedMiB: 7, totalMiB: 8, util: 9 });
    assert.equal(runs.length, 2);
});

test('a run that throws at once, or prints rubbish, is unknown as well', async () => {
    const first = world();
    first.behave(() => { throw new Error('boom'); });
    assert.deepEqual(await first.probe.stats(), UNKNOWN);
    const second = world();
    second.behave(async () => 'Failed to initialize NVML: Driver/library version mismatch');
    assert.deepEqual(await second.probe.stats(), UNKNOWN);
});

test('the reading is kept long enough to matter and short enough to be current', () => {
    assert.ok(GPU_FRESH_MS >= 15_000 && GPU_FRESH_MS <= 30_000, String(GPU_FRESH_MS));
});

// --- the average of the last few ---------------------------------------------------------------------

test('there is no average before anything was measured', () => {
    assert.equal(new RollingAverage(5).average(), null);
});

test('the average is of the last few measurements only', () => {
    const average = new RollingAverage(3);
    for (const value of [1000, 10, 20, 30]) average.add(value);
    assert.equal(average.average(), 20); // the 1000 has dropped out
    average.add(60);
    assert.equal(average.average(), (20 + 30 + 60) / 3);
});

test('a measurement that is not a duration is ignored', () => {
    const average = new RollingAverage(4);
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -5, undefined, null]) average.add(value);
    assert.equal(average.average(), null);
    average.add(0);
    assert.equal(average.average(), 0);
});

test('it always remembers at least one measurement', () => {
    const average = new RollingAverage(0);
    average.add(7);
    average.add(9);
    assert.equal(average.average(), 9);
});
