// The boxes the detector drew around an animal, shown over a visit's video: which boxes belong to a moment of the video, what their labels say, where the
// picture sits in the video element, which part of a box takes a tap, and how the panel reads the server's `detections`. All of it is plain maths in
// src/detections.ts (the drawing is components/kestrel-detection-boxes.ts). Node runs the TypeScript files as they are:  cd dashboard && npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { asVisit, visitPage } from "../src/api.ts";
import { CONTROLS_PX, EDGE_MS, GAP_MS, boxLabel, boxesAt, containRect, hitRect, keepTrack, placeLabel, readDetections, toPixels, videoMsOf } from "../src/detections.ts";

const START = 1_793_327_000_000;
const near = (actual, expected, what = "") => assert.ok(Math.abs(actual - expected) < 1e-9, `${what} expected ${expected}, got ${actual}`);
const box = (over = {}) => ({ x: 0.2, y: 0.4, w: 0.1, h: 0.2, className: "animal", score: 0.82, id: "w1", ...over });
const anon = (over = {}) => { const { id: _id, ...rest } = box(over); return rest; };
const sameRect = (actual, expected) => { for (const key of ["x", "y", "w", "h"]) near(actual[key], expected[key], key); };
/** A track with detections at these video times (ms from the clip's first frame): each is `[ms, ...boxes]`. `t` is made so the video moment comes out right. */
const track = (frames, offsetMs = 0) => ({ clipStartAt: START, offsetMs, frames: frames.map(([at, ...boxes]) => ({ t: START + at - offsetMs, boxes })) });
const both = { interpolate: true };
const steps = { interpolate: false };

// ---- when ---------------------------------------------------------------------------------------------------------------------------------------------

test("a positive offset puts a detection later in the video", () => {
  assert.equal(videoMsOf(START + 500, START, 0), 500);
  assert.equal(videoMsOf(START + 500, START, 200), 700);
  assert.equal(videoMsOf(START + 500, START, -150), 350);
  assert.equal(videoMsOf(START - 100, START, 0), -100);
});

test("at a detection's own moment its boxes are drawn as they are, with or without gliding", () => {
  const walk = track([[1000, box({ x: 0.1 })], [1250, box({ x: 0.2 })], [1500, box({ x: 0.3 })]]);
  for (const options of [both, steps]) {
    assert.deepEqual(boxesAt(walk, 1250, options), [box({ x: 0.2 })]);
    assert.equal(boxesAt(walk, 1250, options), walk.frames[1].boxes);
  }
});

test("between two detections a box slides from one to the other, and its label comes from the closer one", () => {
  const walk = track([[1000, box({ x: 0.1, y: 0.2, w: 0.1, h: 0.2 })], [1250, box({ x: 0.3, y: 0.4, w: 0.3, h: 0.4, label: "Coyote", labelScore: 0.9, score: 0.7 })]]);
  const half = boxesAt(walk, 1125, both);
  assert.equal(half.length, 1);
  near(half[0].x, 0.2, "x"); near(half[0].y, 0.3, "y"); near(half[0].w, 0.2, "w"); near(half[0].h, 0.3, "h");
  const early = boxesAt(walk, 1050, both)[0]; // a fifth of the way: still the first detection's own words
  near(early.x, 0.14); assert.equal(early.label, undefined); assert.equal(early.score, 0.82);
  const late = boxesAt(walk, 1200, both)[0]; // four fifths: the second one's
  near(late.x, 0.26); assert.equal(late.label, "Coyote"); assert.equal(late.labelScore, 0.9); assert.equal(late.score, 0.7);
});

test("the detector's id decides which box is which, not the order they are listed in", () => {
  const walk = track([[1000, box({ id: "w1", x: 0.1 }), box({ id: "w2", x: 0.6 })], [1250, box({ id: "w2", x: 0.7 }), box({ id: "w1", x: 0.2 })]]);
  const half = boxesAt(walk, 1125, both);
  assert.deepEqual(half.map((one) => one.id), ["w1", "w2"]);
  near(half[0].x, 0.15); near(half[1].x, 0.65);
});

test("an animal that is in only one of two detections is not slid anywhere: it stays where it was while that detection is the closer one", () => {
  const left = track([[1000, box({ id: "w1", x: 0.1 }), box({ id: "w2", x: 0.6 })], [1250, box({ id: "w1", x: 0.2 })]]);
  const before = boxesAt(left, 1060, both); // closer to the first detection: both animals, w2 held at its own place
  assert.deepEqual(before.map((one) => one.id), ["w1", "w2"]);
  near(before[1].x, 0.6);
  assert.deepEqual(boxesAt(left, 1190, both).map((one) => one.id), ["w1"]); // closer to the second: w2 is gone
  const arrives = track([[1000, box({ id: "w1", x: 0.1 })], [1250, box({ id: "w1", x: 0.2 }), box({ id: "w3", x: 0.8 })]]);
  assert.deepEqual(boxesAt(arrives, 1060, both).map((one) => one.id), ["w1"]);
  const after = boxesAt(arrives, 1190, both);
  assert.deepEqual(after.map((one) => one.id), ["w1", "w3"]);
  near(after[1].x, 0.8);
});

test("boxes without an id are paired by how close they are, and ones that jumped further than their own size are two animals", () => {
  const near1 = track([[1000, anon({ x: 0.1 })], [1250, anon({ x: 0.15 })]]);
  const slid = boxesAt(near1, 1125, both);
  assert.equal(slid.length, 1);
  near(slid[0].x, 0.125);
  const far = track([[1000, anon({ x: 0.1 })], [1250, anon({ x: 0.8 })]]);
  near(boxesAt(far, 1060, both)[0].x, 0.1);
  near(boxesAt(far, 1190, both)[0].x, 0.8);
  const crossing = track([[1000, anon({ x: 0.1 }), anon({ x: 0.6 })], [1250, anon({ x: 0.62 }), anon({ x: 0.12 })]]); // each goes to the closest, not to the same place in the list
  const two = boxesAt(crossing, 1125, both);
  near(two[0].x, 0.11); near(two[1].x, 0.61);
});

test("detections further apart than the gap are separate sightings: nothing is drawn between them, and only a moment's tail either side", () => {
  const sightings = track([[1000, box({ x: 0.1 })], [3000, box({ x: 0.9 })]]);
  assert.deepEqual(boxesAt(sightings, 2000, both), []);
  assert.deepEqual(boxesAt(sightings, 1500, both), []);
  assert.equal(boxesAt(sightings, 1000 + EDGE_MS, both), sightings.frames[0].boxes); // the tail of the first, as it was
  assert.equal(boxesAt(sightings, 3000 - EDGE_MS, both), sightings.frames[1].boxes); // the lead-in of the second
  assert.deepEqual(boxesAt(sightings, 1000 + EDGE_MS + 1, both), []);
  assert.deepEqual(boxesAt(sightings, 3000 - EDGE_MS - 1, both), []);
});

test("the gap is 700 ms: at it the boxes still slide, one millisecond over they are held and step", () => {
  assert.equal(GAP_MS, 700);
  const just = track([[1000, box({ x: 0.1 })], [1000 + GAP_MS, box({ x: 0.3 })]]);
  near(boxesAt(just, 1350, both)[0].x, 0.2);
  const over = track([[1000, box({ x: 0.1 })], [1000 + GAP_MS + 1, box({ x: 0.3 })]]);
  assert.equal(boxesAt(over, 1350, both), over.frames[0].boxes);
  assert.equal(boxesAt(over, 1352, both), over.frames[1].boxes);
});

test("before the first detection and after the last a box is drawn for 400 ms, then not at all", () => {
  assert.equal(EDGE_MS, 400);
  const one = track([[1000, box()], [1500, box({ x: 0.4 })]]);
  assert.equal(boxesAt(one, 700, both), one.frames[0].boxes);
  assert.equal(boxesAt(one, 600, both), one.frames[0].boxes);
  assert.deepEqual(boxesAt(one, 599, both), []);
  assert.equal(boxesAt(one, 1900, both), one.frames[1].boxes);
  assert.deepEqual(boxesAt(one, 1901, both), []);
  assert.deepEqual(boxesAt(one, -5000, both), []);
});

test("without gliding (reduced motion) the closer detection is drawn, so boxes step at the half way point", () => {
  const walk = track([[1000, box({ x: 0.1 })], [1250, box({ x: 0.3 })]]);
  assert.equal(boxesAt(walk, 1124, steps), walk.frames[0].boxes);
  assert.equal(boxesAt(walk, 1126, steps), walk.frames[1].boxes);
  assert.equal(boxesAt(walk, 1100, steps)[0].x, 0.1);
  const gap = track([[1000, box()], [3000, box()]]);
  assert.deepEqual(boxesAt(gap, 2000, steps), []);
  assert.equal(boxesAt(gap, 1300, steps), gap.frames[0].boxes);
});

test("the offset moves every detection: it is when the video shows the animal, not when the detector saw it", () => {
  const late = track([[1000, box({ x: 0.1 })], [1250, box({ x: 0.3 })]], 300); // detected 300 ms before the video shows it
  assert.equal(late.frames[0].t, START + 700);
  assert.equal(boxesAt(late, 1000, both), late.frames[0].boxes);
  near(boxesAt(late, 1125, both)[0].x, 0.2);
  const early = track([[1000, box({ x: 0.1 })], [1250, box({ x: 0.3 })]], -200);
  assert.equal(boxesAt(early, 1250, both), early.frames[1].boxes);
  near(boxesAt(early, 1125, both)[0].x, 0.2);
});

test("nothing recorded, or a moment that is not a number, draws nothing, and the track itself is left alone", () => {
  assert.deepEqual(boxesAt({ clipStartAt: START, offsetMs: 0, frames: [] }, 1000, both), []);
  const walk = track([[1000, box({ x: 0.1 })], [1250, box({ x: 0.3 })]]);
  assert.deepEqual(boxesAt(walk, Number.NaN, both), []);
  const snapshot = JSON.stringify(walk);
  boxesAt(walk, 1100, both); boxesAt(walk, 1100, steps);
  assert.equal(JSON.stringify(walk), snapshot);
});

// ---- what a box says -----------------------------------------------------------------------------------------------------------------------------------

test("a named species is shown with its own confidence only, an unnamed animal with the detector's score", () => {
  assert.equal(boxLabel(box({ label: "Coyote", labelScore: 0.913 })), "Coyote 91%");
  assert.equal(boxLabel(box({ label: "Coyote" })), "Coyote"); // never the detector's 82% next to a species
  assert.equal(boxLabel(box({ label: "Coyote", labelScore: 0 })), "Coyote 0%");
  assert.equal(boxLabel(box()), "Animal 82%");
  assert.equal(boxLabel(box({ className: "dog", score: 0.7 })), "Dog 70%");
  assert.equal(boxLabel(box({ label: "" })), "Animal 82%");
});

test("percentages are whole numbers, and a score that is missing is left out", () => {
  assert.equal(boxLabel(box({ score: 0.824 })), "Animal 82%");
  assert.equal(boxLabel(box({ score: 0.826 })), "Animal 83%");
  assert.equal(boxLabel(box({ score: 0.999 })), "Animal 100%");
  assert.equal(boxLabel(box({ score: 0.004 })), "Animal 0%");
  assert.equal(boxLabel({ className: "animal" }), "Animal");
  assert.equal(boxLabel({ className: "animal", score: Number.NaN }), "Animal");
  assert.equal(boxLabel({ className: "animal", label: "Coyote", labelScore: Number.NaN }), "Coyote");
});

// ---- where ---------------------------------------------------------------------------------------------------------------------------------------------

test("a 16:10 element shows a 16:9 picture with a band above and below, a 4:3 one with a band each side, a portrait one with wider bands", () => {
  sameRect(containRect(640, 400, 1920, 1080), { x: 0, y: 20, w: 640, h: 360 });
  assert.deepEqual(containRect(640, 400, 640, 400), { x: 0, y: 0, w: 640, h: 400 });
  const four = containRect(640, 400, 2560, 1920);
  near(four.x, 640 / 12, "4:3 left band"); near(four.y, 0); near(four.w, 1600 / 3); near(four.h, 400);
  assert.deepEqual(containRect(640, 400, 1920, 2560), { x: 170, y: 0, w: 300, h: 400 });
});

test("the picture follows the element when it is resized (a phone, a wide panel, a height that is cut off)", () => {
  assert.deepEqual(containRect(390, 243.75, 1920, 1080), { x: 0, y: 12.1875, w: 390, h: 219.375 });
  sameRect(containRect(1280, 800, 1920, 1080), { x: 0, y: 40, w: 1280, h: 720 });
  const cut = containRect(640, 300, 1920, 1080); // max-height makes the element wider than 16:10
  near(cut.h, 300); near(cut.w, 300 * 16 / 9); near(cut.x, (640 - 300 * 16 / 9) / 2); near(cut.y, 0);
});

test("no picture while the video's size or the element's size is not known", () => {
  for (const sizes of [[0, 400, 1920, 1080], [640, 0, 1920, 1080], [640, 400, 0, 0], [640, 400, 1920, 0], [Number.NaN, 400, 1920, 1080], [-640, 400, 1920, 1080]]) {
    assert.equal(containRect(...sizes), null, sizes.join("x"));
  }
});

test("a box lands on the same part of the picture whatever the shape of the clip and the size of the element", () => {
  assert.deepEqual(toPixels({ x: 0.5, y: 0.5, w: 0.25, h: 0.125 }, { x: 170, y: 0, w: 300, h: 400 }), { x: 320, y: 200, w: 75, h: 50 });
  for (const [boxW, boxH] of [[640, 400], [390, 243.75], [1280, 800], [300, 300]]) {
    for (const [videoW, videoH] of [[1920, 1080], [2560, 1920], [1920, 2560], [640, 360]]) {
      const picture = containRect(boxW, boxH, videoW, videoH);
      const middle = toPixels({ x: 0.4, y: 0.4, w: 0.2, h: 0.2 }, picture); // the middle fifth is in the middle of the element
      near(middle.x + middle.w / 2, boxW / 2, `${boxW}x${boxH} ${videoW}x${videoH} x`);
      near(middle.y + middle.h / 2, boxH / 2, `${boxW}x${boxH} ${videoW}x${videoH} y`);
      const whole = toPixels({ x: 0, y: 0, w: 1, h: 1 }, picture);
      assert.deepEqual(whole, picture);
      near(middle.w / middle.h, (picture.w / picture.h), "the shape of the picture is kept");
    }
  }
});

test("a label sits on the box's top edge, inside the box when there is no room above, and always inside the picture", () => {
  const picture = { x: 0, y: 20, w: 640, h: 360 };
  assert.deepEqual(placeLabel({ x: 100, y: 100, w: 80, h: 60 }, 90, 22, picture), { x: 100, y: 78 });
  assert.deepEqual(placeLabel({ x: 100, y: 25, w: 80, h: 60 }, 90, 22, picture), { x: 100, y: 25 }); // no room above: inside the top of the box
  assert.deepEqual(placeLabel({ x: 600, y: 100, w: 40, h: 60 }, 90, 22, picture), { x: 550, y: 78 }); // would run off the right
  assert.deepEqual(placeLabel({ x: -10, y: 100, w: 40, h: 60 }, 90, 22, picture), { x: 0, y: 78 });
  assert.deepEqual(placeLabel({ x: 100, y: 390, w: 20, h: 10 }, 90, 22, picture), { x: 100, y: 358 }); // a small box at the very bottom
  assert.deepEqual(placeLabel({ x: 150, y: 100, w: 80, h: 60 }, 90, 22, { x: 170, y: 0, w: 300, h: 400 }), { x: 170, y: 78 }); // the side band of a portrait picture
});

test("a label that would run under the on/off button moves to the left of it, and one that would not stays", () => {
  const picture = { x: 0, y: 0, w: 640, h: 400 };
  const button = { x: 560, y: 4, w: 56, h: 56 }; // the button in the top right corner, with a little room round it
  assert.deepEqual(placeLabel({ x: 500, y: 40, w: 40, h: 60 }, 120, 22, picture, button), { x: 440, y: 18 });
  assert.deepEqual(placeLabel({ x: 500, y: 40, w: 40, h: 60 }, 120, 22, picture, null), { x: 500, y: 18 });
  assert.deepEqual(placeLabel({ x: 500, y: 200, w: 40, h: 60 }, 120, 22, picture, button), { x: 500, y: 178 }); // far below it
  assert.deepEqual(placeLabel({ x: 300, y: 40, w: 40, h: 60 }, 120, 22, picture, button), { x: 300, y: 18 }); // ends before it
  assert.deepEqual(placeLabel({ x: 540, y: 40, w: 40, h: 60 }, 700, 22, { x: 0, y: 0, w: 600, h: 400 }, button), { x: 0, y: 18 }); // never out of the picture
});

// ---- what takes a tap ------------------------------------------------------------------------------------------------------------------------------------

test("the bottom 76 px of the video belong to its own controls: a box and its label take a tap everywhere else", () => {
  assert.equal(CONTROLS_PX, 76);
  const element = { w: 640, h: 400 }; // the strip starts at y = 324
  assert.deepEqual(hitRect({ x: 100, y: 100, w: 80, h: 60 }, { x: 100, y: 78, w: 90, h: 22 }, element), { x: 100, y: 78, w: 90, h: 82 }); // box and label together
  assert.deepEqual(hitRect({ x: 100, y: 300, w: 80, h: 80 }, { x: 100, y: 278, w: 90, h: 22 }, element), { x: 100, y: 278, w: 90, h: 46 }); // cut off at the strip
  assert.deepEqual(hitRect({ x: 100, y: 322, w: 80, h: 40 }, { x: 100, y: 300, w: 90, h: 22 }, element), { x: 100, y: 300, w: 90, h: 24 }); // only the label's top is above it
  assert.equal(hitRect({ x: 100, y: 350, w: 80, h: 40 }, { x: 100, y: 350, w: 90, h: 22 }, element), null); // all inside the strip: nothing to press
});

test("nothing outside the video element takes a tap, and a short video has little or nothing above its controls", () => {
  const element = { w: 640, h: 400 };
  assert.deepEqual(hitRect({ x: 600, y: 100, w: 80, h: 60 }, { x: 550, y: 78, w: 90, h: 22 }, element), { x: 550, y: 78, w: 90, h: 82 });
  assert.equal(hitRect({ x: 700, y: 100, w: 80, h: 60 }, { x: 700, y: 78, w: 90, h: 22 }, element), null);
  assert.deepEqual(hitRect({ x: -20, y: -10, w: 80, h: 60 }, { x: -20, y: -32, w: 90, h: 22 }, element), { x: 0, y: 0, w: 70, h: 50 });
  assert.equal(hitRect({ x: 10, y: 60, w: 80, h: 30 }, { x: 10, y: 60, w: 90, h: 22 }, { w: 640, h: 100 }), null); // the strip starts at 24 and the box is at 60
  assert.deepEqual(hitRect({ x: 10, y: 5, w: 80, h: 30 }, { x: 10, y: 5, w: 90, h: 22 }, { w: 640, h: 100 }), { x: 10, y: 5, w: 90, h: 19 });
  assert.equal(hitRect({ x: 10, y: 5, w: 80, h: 30 }, { x: 10, y: 5, w: 90, h: 22 }, { w: 640, h: 76 }), null); // a video no taller than its controls
});

// ---- what the server sent ------------------------------------------------------------------------------------------------------------------------------

const valid = () => ({
  clipStartAt: START, offsetMs: 120,
  frames: [
    { t: START + 100, boxes: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.4, className: "animal", score: 0.82, id: "w1" }] },
    { t: START + 350, boxes: [{ x: 0.12, y: 0.2, w: 0.3, h: 0.4, className: "animal", score: 0.8, id: "w1", label: "Coyote", labelScore: 0.91 }, { x: 0.7, y: 0.6, w: 0.1, h: 0.2, className: "animal", score: 0.55 }] },
  ],
});

test("a good track is passed on as it is, also after a trip through JSON", () => {
  assert.deepEqual(readDetections(valid()), valid());
  assert.deepEqual(readDetections(JSON.parse(JSON.stringify(valid()))), valid());
});

test("an answer that is not a track is nothing, and never throws", () => {
  const frames = valid().frames;
  for (const value of [undefined, null, 7, "tracks", [], {}, true, { clipStartAt: START, offsetMs: 0 }, { clipStartAt: "soon", offsetMs: 0, frames }, { clipStartAt: START, offsetMs: Number.NaN, frames },
    { clipStartAt: START, offsetMs: 0, frames: "none" }, { clipStartAt: START, offsetMs: 0, frames: [] }, { clipStartAt: START, offsetMs: 0, frames: [null, 4, "x", { t: START }, { boxes: [] }] },
    { clipStartAt: START, offsetMs: 0, frames: [{ t: START, boxes: [] }] }, { clipStartAt: START, offsetMs: 0, frames: [{ t: START, boxes: [null, { x: 1 }] }] }]) {
    assert.equal(readDetections(value), undefined, JSON.stringify(value));
  }
});

test("a frame or a box that is damaged is left out, the rest is kept, and the frames come out in time order", () => {
  const read = readDetections({
    clipStartAt: START, offsetMs: 0,
    frames: [
      { t: START + 500, boxes: [box({ id: undefined }), { ...box(), w: 0 }, { ...box(), h: -1 }, { ...box(), x: Number.NaN }, { ...box(), score: undefined }, { ...box(), y: "0.4" }, null] },
      { t: "soon", boxes: [box()] },
      { t: START + 100, boxes: [box({ x: 0.5 })] },
      { t: START + 300, boxes: "none" },
      { t: START + 700, boxes: [{ ...box(), w: 0 }] },
    ],
  });
  assert.deepEqual(read.frames.map((frame) => frame.t), [START + 100, START + 500]);
  assert.equal(read.frames[1].boxes.length, 1);
  assert.equal(read.frames[0].boxes[0].x, 0.5);
});

test("what is optional stays out unless it is usable, a missing class is an animal, and extra fields are not passed on", () => {
  const read = readDetections({ clipStartAt: START, offsetMs: 0, frames: [{ t: START, boxes: [
    { x: 0.1, y: 0.1, w: 0.2, h: 0.2, score: 0.5, id: "", label: "", labelScore: "high", extra: 1 },
    { x: 0.3, y: 0.1, w: 0.2, h: 0.2, score: 0.5, className: "", id: 7, label: "Fox", labelScore: Number.POSITIVE_INFINITY },
  ] }] });
  assert.deepEqual(read.frames[0].boxes, [
    { x: 0.1, y: 0.1, w: 0.2, h: 0.2, className: "animal", score: 0.5 },
    { x: 0.3, y: 0.1, w: 0.2, h: 0.2, className: "animal", score: 0.5, label: "Fox" },
  ]);
});

test("a visit's track is read as the visit comes in, and a damaged one never gets into the visit", () => {
  assert.deepEqual(asVisit({ id: "v1", clip: { state: "ready" }, detections: valid() }).detections, valid());
  assert.deepEqual(asVisit({ visit: { id: "v1", clip: { state: "ready" }, detections: valid() } }).detections, valid());
  for (const detections of [{ clipStartAt: "x" }, "tracks", 7, null, { clipStartAt: START, offsetMs: 0, frames: [{ t: START, boxes: [{ x: 1 }] }] }]) {
    const visit = asVisit({ id: "v1", clip: { state: "ready" }, detections });
    assert.equal("detections" in visit, false, JSON.stringify(detections));
  }
  assert.equal("detections" in asVisit({ id: "v1", clip: { state: "ready" } }), false);
  const page = visitPage({ items: [{ id: "a", detections: { clipStartAt: "x" } }, { id: "b", detections: valid() }], next: null });
  assert.equal("detections" in page.items[0], false);
  assert.deepEqual(page.items[1].detections, valid());
});

test("a fresh answer for the visit on screen keeps its track when it has none of its own, while the clip is still there", () => {
  const visit = (over = {}) => ({ id: "v1", species: "Coyote", clip: { state: "ready" }, ...over });
  const track1 = readDetections(valid());
  const other = readDetections({ ...valid(), offsetMs: 0 });
  assert.equal(keepTrack(visit({ detections: track1 }), visit({ species: "Red Fox" })).detections, track1);
  assert.equal(keepTrack(visit({ detections: track1 }), visit({ species: "Red Fox" })).species, "Red Fox");
  assert.equal(keepTrack(visit({ detections: track1 }), visit({ detections: other })).detections, other);
  const next = visit({ id: "v2" });
  assert.equal(keepTrack(visit({ detections: track1 }), next), next); // another visit: its own answer, as it is
  assert.equal(keepTrack(null, next), next);
  const gone = visit({ clip: { state: "deleted" } });
  assert.equal(keepTrack(visit({ detections: track1 }), gone), gone);
  const plain = visit();
  assert.equal(keepTrack(visit(), plain), plain);
});
