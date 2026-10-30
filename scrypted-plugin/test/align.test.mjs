import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
    ALIGN_MAX_DEVIATION_MS, ALIGN_MAX_PLATEAU_MS, ALIGN_MIN_CONTRAST, ALIGN_MIN_PAIRS, ALIGN_MIN_SCORE, ALIGN_MIN_SPAN_MS, ALIGN_RANGE_MS, ALIGN_STEP_MS,
    estimateOffsetMs, isConfidentAlignment, isPlausibleOffset, measureAlignment,
} from '../src/align.ts';
import { decodeGrayFrames } from '../src/clipfiles.ts';

const START = 1_793_000_000_000;            // the wall-clock moment the made-up clips begin

// --- Made-up footage ----------------------------------------------------------------------------------------------------------------------

// A small deterministic random generator, so every run sees the same pictures.
function random(seed) {
    let state = seed;
    return () => {
        state = (state + 0x6D2B79F5) | 0;
        let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
        mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
        return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
    };
}

const clamp = value => Math.max(0, Math.min(255, Math.round(value)));

// A clip: a still background with texture (a flat picture would be skipped as empty), rectangles moving along paths on it, `brightness(seconds)`
// added to every pixel (the camera's exposure moving) and `grain` of fresh noise in every picture. `lead` flat grey pictures come first.
function scene({ width = 192, height = 108, seconds = 24, fps = 10, animals = [], brightness = () => 0, grain = 0, lead = 0, seed = 7 }) {
    const rand = random(seed);
    const still = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) still[y * width + x] = clamp(110 + 40 * Math.sin(x / 6.5) * Math.cos(y / 4.5) + (rand() - 0.5) * 10);
    const frames = Array.from({ length: lead }, () => new Uint8Array(width * height).fill(128));
    for (let i = 0; i < Math.round(seconds * fps); i++) {
        const time = i / fps;
        const frame = new Uint8Array(width * height);
        for (let j = 0; j < frame.length; j++) frame[j] = clamp(still[j] + brightness(time) + (grain ? (rand() - 0.5) * 2 * grain : 0));
        for (const animal of animals) {
            const { x, y } = animal.at(time);
            for (let row = Math.max(0, Math.round(y)); row < Math.min(height, Math.round(y) + animal.h); row++) {
                for (let column = Math.max(0, Math.round(x)); column < Math.min(width, Math.round(x) + animal.w); column++) frame[row * width + column] = animal.shade;
            }
        }
        frames.push(frame);
    }
    return { width, height, fps, frames };
}

// A bright 22 x 14 animal walking back and forth, and a smaller dark one crawling about.
const walker = { w: 22, h: 14, shade: 235, at: seconds => ({ x: 20 + 70 * (1 + Math.sin(0.42 * seconds)), y: 40 + 18 * Math.sin(0.31 * seconds + 1) }) };
const crawler = { w: 16, h: 10, shade: 20, at: seconds => ({ x: 100 + 60 * Math.cos(0.37 * seconds + 2), y: 70 + 12 * Math.sin(0.5 * seconds) }) };
// The walker, but in the portrait picture of the Front Door camera.
const upright = { w: 22, h: 14, shade: 235, at: seconds => ({ x: 15 + 45 * (1 + Math.sin(0.42 * seconds)), y: 70 + 50 * Math.sin(0.33 * seconds + 1) }) };
// An animal that leaves the picture on the right and comes back.
const leaver = { w: 22, h: 14, shade: 235, at: seconds => ({ x: 120 + 75 * Math.sin(0.5 * seconds), y: 45 + 10 * Math.sin(0.3 * seconds) }) };

// When the detector looked: video times from 3 s on, a little less than a second apart.
const TIMES = Array.from({ length: 18 }, (_, k) => 3.05 + k * 0.97);

// The box the detector draws around `animal` at video time `at` (seconds): a pixel bigger on every side, cut at the picture's edge and as a
// share of it, like the boxes the plugin keeps.
function boxAround(video, animal, at, grow = 1) {
    const { x, y } = animal.at(at);
    const x0 = Math.max(0, Math.round(x) - grow);
    const y0 = Math.max(0, Math.round(y) - grow);
    const x1 = Math.min(video.width, Math.round(x) + animal.w + grow);
    const y1 = Math.min(video.height, Math.round(y) + animal.h + grow);
    return { x: x0 / video.width, y: y0 / video.height, w: (x1 - x0) / video.width, h: (y1 - y0) / video.height, className: 'animal', score: 0.9 };
}

// What the detector would have recorded when the clip's video lags its detections by `delta` ms: a sample at wall-clock t is at video time
// (t + delta - START) ms, so the box of the animal at video time `at` is stamped START + at - delta. `lead` seconds of flat pictures come first.
function trackOf(video, animals, times, delta, lead = 0) {
    return times.map(at => ({ t: Math.round(START + (at + lead) * 1000 - delta), boxes: animals.map(animal => boxAround(video, animal, at)) }));
}

// --- Finding the offset ---------------------------------------------------------------------------------------------------------------

test('the offset is found within 40 ms for a clip that lags its detections by -900, -200, 0, +330 and +700 ms, and the evidence is reported', () => {
    const video = scene({ animals: [walker] });
    for (const delta of [-900, -200, 0, 330, 700]) {
        const found = estimateOffsetMs(video, trackOf(video, [walker], TIMES, delta), START);
        assert.ok(found, `a clip that lags by ${delta} ms gives an answer`);
        assert.ok(Math.abs(found.offsetMs - delta) <= 40, `lag ${delta} ms was found as ${found.offsetMs} ms`);
        assert.ok(found.offsetMs % 10 === 0, 'rounded to 10 ms');
        assert.equal(found.pairs, 18);
        assert.ok(Math.abs(found.spanMs - 17 * 970) < 1, `the boxes span ${found.spanMs} ms`);
        assert.ok(found.score > 0.6 && found.score <= 1, `score ${found.score}`);
        assert.ok(found.contrast > 0.5, `contrast ${found.contrast}`);
        assert.ok(found.plateauMs <= ALIGN_MAX_PLATEAU_MS, `plateau ${found.plateauMs} ms`);
    }
});

test('what the cameras do to the picture does not throw it off: grain, the exposure stepping up and down, flat pictures at the start, a second animal, a box cut by the edge, an upright picture', () => {
    // Each scenario is a clip that lags its detections by a different amount.
    const found = (video, animals, delta, lead = 0) => estimateOffsetMs(video, trackOf(video, animals, TIMES, delta, lead), START);

    const grainy = scene({ animals: [walker], grain: 4, seed: 3 });
    assert.ok(Math.abs(found(grainy, [walker], -600).offsetMs + 600) <= 40, 'grain');

    // The exposure steps 18 up at 8 s and 14 down at 15 s (an infrared filter switching): half the pictures differ from the background everywhere.
    const stepped = scene({ animals: [walker], brightness: seconds => seconds < 8 ? 0 : seconds < 15 ? 18 : -14 });
    assert.ok(Math.abs(found(stepped, [walker], 250).offsetMs - 250) <= 40, 'exposure steps');

    // Two seconds of flat grey pictures come first, so the video times of the detections are 2 s later.
    const flatStart = scene({ animals: [walker], lead: 20 });
    assert.ok(Math.abs(found(flatStart, [walker], -300, 2).offsetMs + 300) <= 40, 'flat start');

    const two = scene({ animals: [walker, crawler] });
    const both = found(two, [walker, crawler], 500);
    assert.ok(Math.abs(both.offsetMs - 500) <= 40, 'two animals');
    assert.equal(both.pairs, 36, 'a box for each animal in each event');

    // The animal walks out of the picture on the right for a while: its box is cut at the edge, and so is what is seen of it.
    const leaving = scene({ animals: [leaver] });
    const cut = trackOf(leaving, [leaver], TIMES, -150);
    assert.ok(cut.some(sample => sample.boxes[0].x + sample.boxes[0].w >= 0.999), 'some boxes reach the edge');
    assert.ok(TIMES.some(at => leaver.at(at).x + leaver.w > leaving.width), 'some of the animal is outside');
    assert.ok(Math.abs(estimateOffsetMs(leaving, cut, START).offsetMs + 150) <= 40, 'an animal leaving the picture');

    // The Front Door camera's picture is upright, not wide.
    const portrait = scene({ width: 144, height: 192, animals: [upright] });
    assert.ok(Math.abs(found(portrait, [upright], 700).offsetMs - 700) <= 40, 'portrait');
});

test('events far outside the clip are left out of the average, not counted against it: a long visit whose clip covers only part of it still matches', () => {
    const video = scene({ animals: [walker] });
    const inside = trackOf(video, [walker], TIMES, 330);
    const outside = Array.from({ length: 20 }, (_, k) => ({ t: START + 60_000 + k * 1_000, boxes: [boxAround(video, walker, 5)] }));
    const found = estimateOffsetMs(video, [...outside, ...inside, ...outside.map(sample => ({ ...sample, t: sample.t - 100_000 }))], START);
    assert.ok(found, 'with 40 events no offset in range can bring into the clip');
    assert.ok(Math.abs(found.offsetMs - 330) <= 40);
    assert.equal(found.pairs, 18, 'only the events inside the clip count');
    // An event that an offset within the search range can bring into the clip is counted in the average, and is one more to match.
    const edge = [...inside, { t: START + 24_000 + ALIGN_RANGE_MS - 100, boxes: [boxAround(video, walker, 5)] }];
    assert.equal(measureAlignment(video, edge, START).pairs, 18, 'it is outside the clip as it stands, so it is not one of the boxes inside');
    assert.ok(measureAlignment(video, edge, START).score < measureAlignment(video, inside, START).score, 'but it is in the average, where it scores nothing');
});

// --- What is not believed ------------------------------------------------------------------------------------------------------------

test('nothing is believed when nothing moves, when there is only noise, when the animal is in two events, when the events are under 2 s, or when the boxes are somewhere else', () => {
    const still = scene({});
    const phantom = trackOf(still, [walker], TIMES, 0);
    assert.equal(estimateOffsetMs(still, phantom, START), undefined, 'a still scene: nothing to match');
    assert.equal(measureAlignment(still, phantom, START).score, 0);

    const noise = scene({ grain: 16, seed: 11 });
    assert.equal(estimateOffsetMs(noise, phantom, START), undefined, 'noise only');

    const video = scene({ animals: [walker] });
    const real = trackOf(video, [walker], TIMES, 200);
    assert.ok(estimateOffsetMs(video, real, START), 'the same clip matches with its real boxes');
    assert.equal(estimateOffsetMs(video, [real[2], real[9]], START), undefined, 'the animal in only two events');
    assert.equal(estimateOffsetMs(video, trackOf(video, [walker], TIMES.slice(0, 8).map(at => 3 + (at - 3.05) * 0.2), 200), START), undefined, 'eight events within 1.4 s');
    assert.equal(estimateOffsetMs(video, [], START), undefined, 'no events');
    assert.equal(measureAlignment(video, [], START), undefined, 'and nothing to measure');

    // The boxes lie 40 pixels lower than the animal ever goes.
    const elsewhere = real.map(sample => ({ ...sample, boxes: sample.boxes.map(box => ({ ...box, y: box.y + 40 / video.height })) }));
    assert.equal(estimateOffsetMs(video, elsewhere, START), undefined, 'boxes in another place');
    assert.ok(measureAlignment(video, elsewhere, START).score < 0.2);
});

test('pictures that show nothing (all flat), a clip of one picture, and a bad frame rate leave nothing to measure', () => {
    const flat = { width: 64, height: 48, fps: 10, frames: Array.from({ length: 100 }, () => new Uint8Array(64 * 48).fill(100)) };
    const track = trackOf(flat, [walker], TIMES, 0);
    assert.equal(measureAlignment(flat, track, START), undefined);
    assert.equal(measureAlignment({ ...flat, frames: flat.frames.slice(0, 1) }, track, START), undefined);
    const video = scene({ animals: [walker] });
    assert.equal(measureAlignment({ ...video, fps: 0 }, trackOf(video, [walker], TIMES, 0), START), undefined);
});

test('every rule of the decision has a test just either side of it', () => {
    const good = { offsetMs: 0, score: 0.5, contrast: 0.3, plateauMs: 200, pairs: 10, spanMs: 5_000 };
    assert.equal(isConfidentAlignment(good), true);
    assert.deepEqual([ALIGN_MIN_SCORE, ALIGN_MIN_CONTRAST, ALIGN_MAX_PLATEAU_MS, ALIGN_MIN_PAIRS, ALIGN_MIN_SPAN_MS, ALIGN_RANGE_MS, ALIGN_STEP_MS], [0.4, 0.15, 600, 6, 2_000, 3_000, 20]);
    const sides = [
        ['score', 0.4, 0.3999], ['contrast', 0.15, 0.1499], ['plateauMs', 600, 620], ['pairs', 6, 5], ['spanMs', 2_000, 1_999],
    ];
    for (const [field, inside, outside] of sides) {
        assert.equal(isConfidentAlignment({ ...good, [field]: inside }), true, `${field} ${inside} is enough`);
        assert.equal(isConfidentAlignment({ ...good, [field]: outside }), false, `${field} ${outside} is not`);
    }
});

test('a measured offset more than 1.5 s from the default for its source is not believed, one just inside it is', () => {
    assert.equal(ALIGN_MAX_DEVIATION_MS, 1_500);
    assert.equal(isPlausibleOffset(330, 330), true);
    assert.equal(isPlausibleOffset(-440 + 1_500, -440), true, 'exactly 1.5 s above the default');
    assert.equal(isPlausibleOffset(-440 - 1_500, -440), true, 'exactly 1.5 s below it');
    assert.equal(isPlausibleOffset(-440 + 1_510, -440), false);
    assert.equal(isPlausibleOffset(330 - 1_510, 330), false);
    assert.equal(isPlausibleOffset(-2_800, -440), false, 'the edge of the search range, as the reversed-boxes control found');
});

test('the number of boxes decides: five boxes over 3 s are not enough, six are; and so does the time they are spread over: 1.9 s is not enough, 2.1 s is', () => {
    const fast = { w: 22, h: 14, shade: 235, at: seconds => ({ x: 20 + 70 * (1 + Math.sin(0.9 * seconds)), y: 40 + 18 * Math.sin(0.7 * seconds + 1) }) };
    const video = scene({ animals: [fast] });
    const across = (count, seconds, from = 4) => Array.from({ length: count }, (_, k) => from + (k * seconds) / (count - 1));
    const five = measureAlignment(video, trackOf(video, [fast], across(5, 3), 200), START);
    const six = measureAlignment(video, trackOf(video, [fast], across(6, 3), 200), START);
    assert.deepEqual([five.pairs, six.pairs], [5, 6]);
    assert.equal(isConfidentAlignment(five), false, 'five boxes');
    assert.equal(isConfidentAlignment(six), true, 'six boxes');
    assert.ok(Math.abs(six.offsetMs - 200) <= 40);
    const short = measureAlignment(video, trackOf(video, [fast], across(8, 1.9), 200), START);
    const long = measureAlignment(video, trackOf(video, [fast], across(8, 2.1), 200), START);
    assert.ok(short.spanMs < 2_000 && long.spanMs >= 2_000, `${short.spanMs} and ${long.spanMs} ms`);
    assert.equal(isConfidentAlignment(short), false, '1.9 s');
    assert.equal(isConfidentAlignment(long), true, '2.1 s');
    assert.equal(estimateOffsetMs(video, trackOf(video, [fast], across(8, 1.9), 200), START), undefined);
    assert.ok(Math.abs(estimateOffsetMs(video, trackOf(video, [fast], across(8, 2.1), 200), START).offsetMs - 200) <= 40);
});

test('the score decides: boxes that are right for 4 of 10 events score just under 0.40 and are not believed, 5 of 10 just over and are', () => {
    const video = scene({ animals: [walker] });
    const times = Array.from({ length: 10 }, (_, k) => 3.05 + k * 1.7);
    // The other events have their boxes 40 pixels lower than the animal ever goes.
    const mixed = right => trackOf(video, [walker], times, 200).map((sample, k) => k < right ? sample
        : { ...sample, boxes: sample.boxes.map(box => ({ ...box, y: box.y + 40 / video.height })) });
    const four = measureAlignment(video, mixed(4), START);
    const five = measureAlignment(video, mixed(5), START);
    assert.ok(four.score < ALIGN_MIN_SCORE && four.score > ALIGN_MIN_SCORE - 0.1, `4 of 10: ${four.score}`);
    assert.ok(five.score >= ALIGN_MIN_SCORE && five.score < ALIGN_MIN_SCORE + 0.1, `5 of 10: ${five.score}`);
    assert.ok(four.contrast >= ALIGN_MIN_CONTRAST && four.plateauMs <= ALIGN_MAX_PLATEAU_MS && four.pairs >= ALIGN_MIN_PAIRS, 'everything else about the four is fine');
    assert.equal(isConfidentAlignment(four), false, '4 of 10 right');
    assert.equal(isConfidentAlignment(five), true, '5 of 10 right');
    assert.equal(estimateOffsetMs(video, mixed(4), START), undefined);
    assert.ok(Math.abs(estimateOffsetMs(video, mixed(5), START).offsetMs - 200) <= 40);
});

test('the sharpness decides: an animal that hardly moves matches at every offset, so its plateau is wide and it is not believed; one that moves is', () => {
    const dozing = { w: 22, h: 14, shade: 235, at: seconds => ({ x: 80 + seconds * 0.4, y: 45 }) };
    const sleepy = scene({ animals: [dozing] });
    const wide = measureAlignment(sleepy, trackOf(sleepy, [dozing], TIMES, 0), START);
    assert.ok(wide.plateauMs > ALIGN_MAX_PLATEAU_MS, `plateau ${wide.plateauMs} ms`);
    assert.ok(wide.contrast < ALIGN_MIN_CONTRAST, `contrast ${wide.contrast}`);
    assert.equal(isConfidentAlignment(wide), false);
    const video = scene({ animals: [walker] });
    const sharp = measureAlignment(video, trackOf(video, [walker], TIMES, 0), START);
    assert.ok(sharp.plateauMs <= ALIGN_MAX_PLATEAU_MS && sharp.contrast >= ALIGN_MIN_CONTRAST);
    assert.equal(isConfidentAlignment(sharp), true);
});

test('the same footage and boxes always give the same answer', () => {
    const video = scene({ animals: [walker, crawler], grain: 3 });
    const track = trackOf(video, [walker, crawler], TIMES, -400);
    assert.deepEqual(measureAlignment(video, track, START), measureAlignment(video, track, START));
});

// --- Pictures from a real video file ----------------------------------------------------------------------------------------------------

const ffmpegAvailable = spawnSync('ffmpeg', ['-version']).status === 0;

// A clip of `width` x `height` at 25 fps: a textured still picture and a white square moving about on it.
function makeClip(file, { width, height, seconds = 12 }) {
    const made = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', `nullsrc=s=${width}x${height}:r=25:d=${seconds},format=gray,geq=lum='128+60*sin(X/9)*sin(Y/7)'`,
        '-f', 'lavfi', '-i', `color=c=white:s=${Math.round(width * 0.11)}x${Math.round(height * 0.12)}:r=25:d=${seconds}`,
        '-filter_complex', `[0][1]overlay=x='${width * 0.44}+${width * 0.34}*sin(t*0.9)':y='${height * 0.42}+${height * 0.2}*sin(t*0.6+1)':eval=frame,format=yuv420p`,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', file], { encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);
}

test('a clip is decoded into small grayscale pictures, ten a second, the longer side 192 pixels, the shape kept', { skip: !ffmpegAvailable }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kestrel-align-test-'));
    try {
        for (const [width, height, expected] of [[320, 240, [192, 144]], [240, 320, [144, 192]], [320, 180, [192, 108]], [1280, 720, [192, 108]]]) {
            const file = join(directory, `${width}x${height}.mp4`);
            makeClip(file, { width, height, seconds: 6 });
            const video = await decodeGrayFrames('ffmpeg', file);
            assert.deepEqual([video.width, video.height], expected, `${width} x ${height}`);
            assert.equal(video.fps, 10);
            assert.ok(Math.abs(video.frames.length - 60) <= 1, `${video.frames.length} pictures for 6 s`);
            assert.ok(video.frames.every(frame => frame instanceof Uint8Array && frame.length === video.width * video.height));
            assert.ok(video.frames[30].some(value => value > 200) && video.frames[30].some(value => value < 100), 'the white square and the dark texture are both in it');
        }
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test('what is decoded from a real video matches its boxes at the offset they were made for', { skip: !ffmpegAvailable }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kestrel-align-test-'));
    try {
        const file = join(directory, 'clip.mp4');
        makeClip(file, { width: 320, height: 240, seconds: 24 });
        const video = await decodeGrayFrames('ffmpeg', file);
        // The square's top-left corner at video time t, as ffmpeg moves it (size 35 x 29 at this picture size).
        const square = { w: Math.round(320 * 0.11) * (192 / 320), h: Math.round(240 * 0.12) * (144 / 240),
            at: t => ({ x: (320 * 0.44 + 320 * 0.34 * Math.sin(t * 0.9)) * (192 / 320), y: (240 * 0.42 + 240 * 0.2 * Math.sin(t * 0.6 + 1)) * (144 / 240) }) };
        for (const delta of [-500, 0, 400]) {
            const found = estimateOffsetMs(video, trackOf(video, [square], TIMES, delta), START);
            assert.ok(found, `lag ${delta} ms is found in a real video`);
            assert.ok(Math.abs(found.offsetMs - delta) <= 60, `lag ${delta} ms was found as ${found.offsetMs} ms`);
        }
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a file that is missing, is not a video, has no picture in it, or is too long gives nothing; and nothing is left running', { skip: !ffmpegAvailable }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kestrel-align-test-'));
    try {
        assert.equal(await decodeGrayFrames('ffmpeg', join(directory, 'missing.mp4')), undefined, 'no such file');
        const text = join(directory, 'notes.mp4');
        await writeFile(text, 'this is not a video');
        assert.equal(await decodeGrayFrames('ffmpeg', text), undefined, 'not a video');
        const sound = join(directory, 'tone.m4a');
        const tone = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'aac', sound], { encoding: 'utf8' });
        assert.equal(tone.status, 0, tone.stderr);
        assert.equal(await decodeGrayFrames('ffmpeg', sound), undefined, 'sound only');
        const video = join(directory, 'clip.mp4');
        makeClip(video, { width: 160, height: 120, seconds: 3 });
        assert.equal(await decodeGrayFrames(join(directory, 'no-ffmpeg'), video), undefined, 'no ffmpeg to ask');
        // More than 1200 pictures (two minutes at ten a second) is not one of our clips.
        const long = join(directory, 'long.mp4');
        const made = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=64x48:r=10:d=125', '-c:v', 'libx264', '-preset', 'ultrafast', long], { encoding: 'utf8' });
        assert.equal(made.status, 0, made.stderr);
        assert.equal(await decodeGrayFrames('ffmpeg', long), undefined, '125 s');
        const justRight = join(directory, 'two-minutes.mp4');
        const fine = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=64x48:r=10:d=119', '-c:v', 'libx264', '-preset', 'ultrafast', justRight], { encoding: 'utf8' });
        assert.equal(fine.status, 0, fine.stderr);
        assert.ok((await decodeGrayFrames('ffmpeg', justRight)).frames.length <= 1_200, '119 s is looked at');
    } finally { await rm(directory, { recursive: true, force: true }); }
});
