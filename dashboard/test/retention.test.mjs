// Bird recordings in the settings sheet (src/retention.ts): how the server's answer is read, the storage line, and the words under each choice.
// Node runs the TypeScript files as they are:  cd dashboard && npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { api } from "../src/api.ts";
import { birdnetFailure } from "../src/format.ts";
import { DAY_OPTIONS, MODE_OPTIONS, fullPercent, guardNote, keepAbout, keptLine, modeOf, recordingRetention, removalQuestion, spaceLine, spaceWarning, tidyNote, timeChoice } from "../src/retention.ts";

const GB = 1_000_000_000;
/** What the integration sends today: 30 days, 4.2 GB of 30 GB, twelve recordings kept. */
const answer = (changes = {}) => ({ keep: "30", days: 30, spacePercent: 85, guardPercent: 90, storage: { usedBytes: 4.2 * GB, totalBytes: 30 * GB }, kept: 12, minClips: 10, checkMinutes: 15, canChange: true, ...changes });
const state = (changes = {}) => recordingRetention(answer(changes));
const full = { usedBytes: 27.6 * GB, totalBytes: 30 * GB };

test("a plain answer is read as it is", () => {
  assert.deepEqual(recordingRetention(answer()), answer());
  assert.deepEqual(recordingRetention(answer({ keep: "space", canChange: false })), answer({ keep: "space", canChange: false }));
});

test("a strange answer never shows a wrong number or lets someone change it", () => {
  const strange = recordingRetention({ keep: "forever", days: 0, spacePercent: 0, guardPercent: 400, storage: { usedBytes: -1, totalBytes: 0 }, kept: "twelve", checkMinutes: 0, canChange: "true" });
  assert.deepEqual(strange, { keep: "other", days: null, spacePercent: 85, guardPercent: 90, storage: null, kept: null, minClips: null, checkMinutes: null, canChange: false });
  for (const nothing of [null, undefined, "30", 7, []]) assert.equal(recordingRetention(nothing).storage, null);
  assert.equal(recordingRetention(null).keep, "other");
  assert.equal(recordingRetention(null).canChange, false);
  assert.deepEqual(recordingRetention(answer({ storage: { usedBytes: 5, totalBytes: 0 } })).storage, null);
  assert.deepEqual(recordingRetention(answer({ storage: { usedBytes: 0, totalBytes: 30 * GB } })).storage, { usedBytes: 0, totalBytes: 30 * GB });
});

test("each way BirdNET-Go can be set is read as one the sheet knows", () => {
  for (const keep of ["30", "60", "90", "space", "off", "other"]) assert.equal(recordingRetention(answer({ keep })).keep, keep);
  assert.equal(recordingRetention(answer({ keep: 30 })).keep, "other");
});

test("the two questions: a set time or until space runs low, then 30, 60 or 90 days", () => {
  assert.deepEqual(MODE_OPTIONS.map((option) => option.label), ["For a set time", "Until space runs low"]);
  assert.deepEqual(DAY_OPTIONS.map((option) => option.value), ["30", "60", "90"]);
  assert.deepEqual(DAY_OPTIONS.map((option) => option.label), ["30 days", "60 days", "90 days"]);
  assert.equal(modeOf("30"), "time");
  assert.equal(modeOf("90"), "time");
  assert.equal(modeOf("space"), "space");
  assert.equal(modeOf("off"), "");
  assert.equal(modeOf("other"), "");
});

test("pressing 'For a set time' goes back to the age BirdNET-Go already has, or to 30 days", () => {
  assert.equal(timeChoice(state({ keep: "space", days: 60 })), "60");
  assert.equal(timeChoice(state({ keep: "off", days: 90 })), "90");
  assert.equal(timeChoice(state({ keep: "other", days: 45 })), "30");
  assert.equal(timeChoice(state({ keep: "space", days: null })), "30");
});

test("the storage line has a big amount, the size it is out of, and how full it is", () => {
  assert.deepEqual(spaceLine({ usedBytes: 4.2 * GB, totalBytes: 30 * GB }), { used: "4.2 GB", rest: "of 30 GB used · 14% full" });
  assert.deepEqual(spaceLine({ usedBytes: 0, totalBytes: 30 * GB }), { used: "0 KB", rest: "of 30 GB used · 0% full" });
  assert.equal(spaceLine({ usedBytes: 12 * GB, totalBytes: 30 * GB }).used, "12 GB");
  assert.equal(fullPercent({ usedBytes: 30 * GB - 1, totalBytes: 30 * GB }), 99);
  assert.equal(fullPercent({ usedBytes: 31 * GB, totalBytes: 30 * GB }), 100);
});

test("what was kept says so, and says nothing when BirdNET-Go could not count", () => {
  assert.equal(keptLine(null), null);
  assert.match(keptLine(0), /No recordings kept yet\. A recording you keep is never removed\./);
  assert.equal(keptLine(1), "1 recording you've kept is never removed.");
  assert.equal(keptLine(12), "12 recordings you've kept are never removed.");
});

test("each choice says in plain words what happens: oldest go first, kept recordings never", () => {
  const time = keepAbout(state(), "60");
  assert.equal(time.lead, "60 days.");
  assert.match(time.text, /older than 60 days are removed, oldest first\. Recordings you keep are never removed\./);
  const space = keepAbout(state({ spacePercent: 85 }), "space");
  assert.equal(space.lead, "Until space runs low.");
  assert.match(space.text, /85% full, the oldest are removed first/);
  assert.match(space.text, /Recordings you keep are never removed\./);
  assert.equal(keepAbout(state({ keep: "off" }), "off").lead, "Nothing is removed.");
  assert.match(keepAbout(state({ keep: "other" }), "other").text, /rule that Kestrel doesn't offer/);
});

test("a time limit says what keeps it from filling the storage", () => {
  assert.match(guardNote(state()), /reaches 90% full, Kestrel switches to “Until space runs low” by itself/);
  assert.match(guardNote(state({ guardPercent: 95 })), /reaches 95% full/);
});

test("a nearly full storage is flagged, with what happens next for the way recordings are kept", () => {
  assert.equal(spaceWarning(state(), "30"), null);
  assert.equal(spaceWarning(state({ storage: null }), "30"), null);
  assert.equal(spaceWarning(state({ storage: { usedBytes: 26.9 * GB, totalBytes: 30 * GB } }), "30"), null);
  assert.match(spaceWarning(state({ storage: full }), "60"), /^The storage is 92% full\. Kestrel switches to “Until space runs low” as soon as it next checks\.$/);
  assert.match(spaceWarning(state({ storage: full }), "space"), /^The storage is 92% full\. BirdNET-Go removes the oldest recordings first, but never ones you've kept\.$/);
  assert.equal(spaceWarning(state({ storage: full }), "off"), "The storage is 92% full.");
});

test("a longer time never asks; a shorter one, or a way that keeps more, does", () => {
  assert.equal(removalQuestion(state({ keep: "30" }), "60"), null);
  assert.equal(removalQuestion(state({ keep: "30" }), "90"), null);
  assert.equal(removalQuestion(state({ keep: "60" }), "90"), null);
  const shorter = removalQuestion(state({ keep: "90" }), "30");
  assert.equal(shorter.question, "Remove recordings older than 30 days?");
  assert.match(shorter.about, /^BirdNET-Go starts within 15 minutes, oldest first\. Recordings you keep are never removed\. Removed recordings can't be brought back\.$/);
  assert.equal(shorter.button, "Remove older recordings");
  assert.equal(removalQuestion(state({ keep: "90" }), "60").question, "Remove recordings older than 60 days?");
  for (const before of ["space", "off", "other"]) assert.equal(removalQuestion(state({ keep: before }), "90").question, "Remove recordings older than 90 days?");
});

test("until space runs low only asks while the storage is already past its limit", () => {
  assert.equal(removalQuestion(state({ keep: "30" }), "space"), null);
  assert.equal(removalQuestion(state({ keep: "off", storage: null }), "space"), null);
  assert.equal(removalQuestion(state({ keep: "space", storage: full }), "space"), null);
  const past = removalQuestion(state({ keep: "30", storage: full }), "space");
  assert.equal(past.question, "Remove the oldest recordings?");
  assert.match(past.about, /^The storage is 92% full\. BirdNET-Go starts within 15 minutes and removes the oldest recordings until it is below 85%\./);
  assert.equal(past.button, "Remove oldest recordings");
});

test("how soon it starts says 'soon' when the clean-up interval is not known, and reads one minute right", () => {
  assert.match(removalQuestion(state({ keep: "90", checkMinutes: null }), "30").about, /^BirdNET-Go starts soon, oldest first\./);
  assert.match(removalQuestion(state({ keep: "90", checkMinutes: 1 }), "30").about, /starts within 1 minute, oldest first\./);
});

test("the small print says how often BirdNET-Go tidies up and what it always leaves", () => {
  assert.equal(tidyNote(state()), "BirdNET-Go tidies up every 15 minutes and always leaves at least 10 recordings of each species.");
  assert.equal(tidyNote(state({ checkMinutes: 1, minClips: 1 })), "BirdNET-Go tidies up every minute and always leaves at least 1 recording of each species.");
  assert.equal(tidyNote(state({ minClips: 0 })), "BirdNET-Go tidies up every 15 minutes.");
  assert.equal(tidyNote(state({ checkMinutes: null })), "BirdNET-Go tidies up and always leaves at least 10 recordings of each species.");
  assert.equal(tidyNote(state({ checkMinutes: null, minClips: null })), null);
});

test("a failed change says why in a sentence, and an administrator-only refusal says so", () => {
  assert.equal(birdnetFailure({ code: "unauthorized", message: "unauthorized" }), "Only a Home Assistant administrator can change this.");
  assert.equal(birdnetFailure({ code: "invalid_format", message: "The recording storage is 92% full, so a time limit can't be set right now" }), "The recording storage is 92% full, so a time limit can't be set right now.");
  assert.equal(birdnetFailure(new Error("BirdNET-Go did not keep the change.")), "BirdNET-Go did not keep the change.");
  for (const nothing of [null, undefined, "boom", new Error("  ")]) assert.equal(birdnetFailure(nothing), "Kestrel couldn't reach BirdNET-Go.");
});

test("reading and saving go through the two server commands and come back read the same way", async () => {
  const sent = [];
  const hass = { callWS: async (message) => { sent.push(message); return answer({ keep: message.keep ?? "30", canChange: 1 }); } };
  const read = await api.retention(hass);
  assert.deepEqual(sent[0], { type: "kestrel/recording_retention/get" });
  assert.equal(read.keep, "30");
  assert.equal(read.canChange, false, "only a real true lets the person change it");
  const saved = await api.setRetention(hass, "space");
  assert.deepEqual(sent[1], { type: "kestrel/recording_retention/set", keep: "space" });
  assert.equal(saved.keep, "space");
});
