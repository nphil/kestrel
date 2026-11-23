// What the bench sends is checked against what the plugin reads: every message and event shape goes through the plugin's own parsers
// (heard.ts readBirdnetMessage / modelOf / occurrenceOf, track.ts normalizeBoxes), so a change in what the plugin expects fails here.
// Run: node --experimental-strip-types --test tools/kestrel_bench/test/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { birdnetTimestamp, heardCallOf, modelOf, occurrenceOf, readBirdnetMessage } from "../../../scrypted-plugin/src/heard.ts";
import { TRACK_MIN_GAP_MS, normalizeBoxes } from "../../../scrypted-plugin/src/track.ts";
import { classOf } from "../sandbox.mjs";
import { BIRDNET_TIME_ZONE, OCCURRENCE, birdnetMessage, clipNameFor, detectionEvent, walkTrack, wallClock } from "../shapes.mjs";
import { findSpecies, heardName, loadSpecies, searchSpecies, seenName } from "../species.mjs";

// 2026-11-14 14:03:07 in New York is 19:03:07 UTC (winter time, UTC-5).
const AT = Date.UTC(2026, 10, 14, 19, 3, 7);
const base = { commonName: "Pileated Woodpecker", scientificName: "Dryocopus pileatus", confidence: 0.87, at: AT, source: "Backyard", detectionId: 4412 };

test("a v3.0 message is read as BirdNET v3.0 with the time, score, source, clip and detection number it was built from", () => {
  const reading = readBirdnetMessage(birdnetMessage(base), classOf, 0);
  assert.equal(reading.species, "Pileated Woodpecker");
  assert.equal(reading.scientific, "Dryocopus pileatus");
  assert.equal(reading.source, "Backyard");
  assert.equal(reading.at, AT, "the wall-clock Date + Time come back to the same moment");
  assert.equal(reading.score, 0.87);
  assert.equal(reading.grp, "bird");
  assert.deepEqual(reading.model, { key: "birdnet_v3", label: "BirdNET v3.0", rank: 3 });
  assert.equal(reading.detectionId, 4412);
  assert.equal(reading.clip, "dryocopus_pileatus_87p_20261114T140309Z.opus");
  assert.equal(reading.occurrence, OCCURRENCE.common);
});

test("every model spelling is read: nested, flat, Perch, old BirdNET 2.4 and no model at all", () => {
  const keyOf = (options) => modelOf(birdnetMessage({ ...base, ...options }));
  assert.equal(keyOf({ model: "v3" }).key, "birdnet_v3");
  assert.equal(keyOf({ model: "v3", style: "flat" }).key, "birdnet_v3");
  assert.deepEqual(keyOf({ model: "perch" }), { key: "perch_v2", label: "Perch v2", rank: 2 });
  assert.equal(keyOf({ model: "perch", style: "flat" }).key, "perch_v2");
  assert.deepEqual(keyOf({ model: "v24" }), { key: "birdnet_v24", label: "BirdNET v2.4", rank: 1 });
  assert.equal(keyOf({ model: "none" }).rank, 0);
  assert.throws(() => birdnetMessage({ ...base, model: "gpt" }), /Unknown model/);
});

test("occurrence: a number is read as it is, `unknown` leaves the field out, and the three named levels sit on the plugin's sides of its rare line", () => {
  assert.equal(occurrenceOf(birdnetMessage({ ...base, occurrence: OCCURRENCE.rare })), 0.04);
  const unknown = birdnetMessage({ ...base, occurrence: OCCURRENCE.unknown });
  assert.equal("occurrence" in unknown, false);
  assert.equal(occurrenceOf(unknown), null);
  assert.ok(OCCURRENCE.rare < 0.1 && OCCURRENCE.uncommon >= 0.1 && OCCURRENCE.common >= 0.1, "rare is below the plugin's 0.1 line, the others are not");
});

test("the clip name follows BirdNET-Go's file pattern and can be left out; a detection number of 0 is kept as 0", () => {
  assert.match(clipNameFor("Nycticorax nycticorax", 0.57, AT), /^nycticorax_nycticorax_57p_\d{8}T\d{6}Z\.opus$/);
  assert.equal(readBirdnetMessage(birdnetMessage({ ...base, clipName: null }), classOf, 0).clip, null);
  assert.equal(readBirdnetMessage(birdnetMessage({ ...base, detectionId: 0 }), classOf, 0).detectionId, 0);
  const lone = birdnetMessage({ ...base, detectionId: undefined });
  assert.equal("DetectionID" in lone, false);
  assert.equal(readBirdnetMessage(lone, classOf, 0).detectionId, null);
});

test("Date and Time are local wall-clock strings for the message's zone, winter and summer", () => {
  assert.deepEqual(wallClock(AT, BIRDNET_TIME_ZONE), { date: "2026-11-14", time: "14:03:07", stamp: "20261114T140307Z" });
  const summer = Date.UTC(2026, 6, 4, 23, 59, 58);
  assert.equal(wallClock(summer).time, "19:59:58");
  assert.equal(birdnetTimestamp(birdnetMessage({ ...base, at: summer })), summer);
  assert.equal(birdnetTimestamp(birdnetMessage({ ...base, at: AT, timeZone: "UTC" })), AT);
});

test("the call the ingest keeps carries the reading's model, score, occurrence, clip and detection number", () => {
  const reading = readBirdnetMessage(birdnetMessage({ ...base, model: "perch" }), classOf, 0);
  const call = heardCallOf(reading, reading.grp, "88", AT + 500);
  assert.deepEqual({ ...call }, {
    cameraId: "88", at: AT, receivedAt: AT + 500, species: "Pileated Woodpecker", scientific: "Dryocopus pileatus", grp: "bird", score: 0.87, occurrence: OCCURRENCE.common,
    model: "perch_v2", modelRank: 2, modelLabel: "Perch v2", detectionId: 4412, clip: "dryocopus_pileatus_87p_20261114T140309Z.opus", unlikely: false,
  });
});

test("BirdNET-Go's unlikely tag is left out of a message unless asked for (BirdNET-Go leaves it out when false), and the plugin's reader and the call it keeps carry it", () => {
  const plain = birdnetMessage(base);
  assert.equal("unlikely" in plain, false);
  const tagged = birdnetMessage({ ...base, unlikely: true });
  assert.equal(tagged.unlikely, true);
  const reading = readBirdnetMessage(tagged, classOf, 0);
  assert.equal(reading.unlikely, true);
  assert.equal(readBirdnetMessage(plain, classOf, 0).unlikely, false);
  assert.equal(heardCallOf(reading, reading.grp, "88", AT).unlikely, true);
});

test("the plugin sorts animals the way the bench's species groups say: a mammal, a frog, a bird, and an insect that is dropped", () => {
  const groupOf = (scientific) => readBirdnetMessage(birdnetMessage({ ...base, commonName: "x", scientificName: scientific }), classOf, 0).grp;
  assert.equal(groupOf("Canis latrans"), "mammal");
  assert.equal(groupOf("Pseudacris crucifer"), "other");
  assert.equal(groupOf("Cardinalis cardinalis"), "bird");
  assert.equal(groupOf("Apis mellifera"), "drop");
  const list = loadSpecies(classOf);
  assert.equal(findSpecies(list, "coyote").group, "mammal");
  assert.equal(findSpecies(list, "Western Honey Bee").group, "insect");
  assert.equal(findSpecies(list, "northern cardinal").group, "bird");
});

test("a detection event is Scrypted-shaped and the plugin's own box reader turns it into boxes with the classifier's name once it has one", () => {
  const event = detectionEvent({ t: 1000, inputDimensions: [640, 360], animals: [{ id: "a", x: 0.25, y: 0.5, w: 0.5, h: 0.25, score: 0.9, label: "Coyote", labelScore: 0.8 }] });
  assert.deepEqual(event.detections[0].boundingBox, [160, 180, 320, 90], "pixel boxes [x, y, width, height]");
  assert.deepEqual(normalizeBoxes(event.detections, event.inputDimensions), [{ x: 0.25, y: 0.5, w: 0.5, h: 0.25, className: "animal", score: 0.9, id: "a", label: "Coyote", labelScore: 0.8 }]);
});

test("a walk is evenly spaced events a box can follow: it moves left to right, is named after the first second, and a second animal is never named", () => {
  for (const ratio of [16 / 9, 4 / 3, 3 / 4]) {
    const track = walkTrack({ startAt: 5000, ratio, label: "Coyote", labelScore: 0.9 });
    assert.equal(track.length, 12);
    assert.deepEqual(track.map((event) => event.timestamp), Array.from({ length: 12 }, (_, i) => 5000 + i * 250));
    assert.ok(track.every((event, i) => i === 0 || event.timestamp - track[i - 1].timestamp >= TRACK_MIN_GAP_MS), "none is thinned out by the recorder's throttle");
    const walkers = track.map((event) => normalizeBoxes(event.detections, event.inputDimensions)[0]);
    assert.equal(walkers[0].label, undefined, "just 'animal' at first");
    assert.equal(walkers[3].label, undefined);
    assert.equal(walkers[4].label, "Coyote");
    assert.ok(walkers.every((box, i) => i === 0 || box.x > walkers[i - 1].x), "left to right");
    assert.ok(walkers.every((box) => box.x >= 0 && box.y >= 0 && box.x + box.w <= 1 && box.y + box.h <= 1), `inside the picture (ratio ${ratio.toFixed(2)})`);
    const pixelRatio = (box, event) => (box.w * event.inputDimensions[0]) / (box.h * event.inputDimensions[1]);
    assert.ok(pixelRatio(walkers[5], track[5]) < 1.4, "a box keeps an animal's proportions on any picture shape");
    const other = track.map((event) => normalizeBoxes(event.detections, event.inputDimensions)[1]).filter(Boolean);
    assert.ok(other.length > 0 && other.every((box) => box.label === undefined));
  }
  assert.equal(normalizeBoxes(walkTrack({ startAt: 0, label: "Coyote" })[6].detections, [640, 360])[0].labelScore, undefined, "no label score unless one is given");
});

test("search finds an animal by a few letters of its common or scientific name, by either list's name, and ranks the home's common ones first", () => {
  const list = loadSpecies(classOf);
  assert.ok(list.length > 244, "the camera classifier's list and BirdNET-Go's list merged");
  assert.equal(searchSpecies(list, "cardin")[0].scientific, "Cardinalis cardinalis");
  assert.equal(searchSpecies(list, "dryocopus")[0].scientific, "Dryocopus pileatus");
  assert.equal(searchSpecies(list, "great horned")[0].scientific, "Bubo virginianus");
  assert.equal(searchSpecies(list, "gt hor").length, 0);
  assert.deepEqual(searchSpecies(list, ""), []);
  const hound = findSpecies(list, "Pseudacris crucifer");
  assert.equal(heardName(hound), "Spring Peeper");
  assert.equal(seenName(hound), "Spring Peeper", "an animal one list lacks takes the other list's name");
  const both = findSpecies(list, "Eurasian Collared-Dove");
  assert.ok(both.sources.includes("BirdNET-Go"));
});
