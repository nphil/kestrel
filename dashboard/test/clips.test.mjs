// Deleting saved clips: the words the panel uses (src/clips.ts), the sizes (src/format.ts) and how it reads the server's numbers (src/api.ts).
// Node runs the TypeScript files as they are:  cd dashboard && npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { clipStorage } from "../src/api.ts";
import { AGE_CHOICES, clipCount, clipFailure, confirmQuestion, cutoff, resultLine } from "../src/clips.ts";
import { formatBytes } from "../src/format.ts";

test("sizes read like the settings line: GB with one decimal, MB whole, KB for the small", () => {
  assert.equal(formatBytes(1_400_000_000), "1.4 GB");
  assert.equal(formatBytes(210_400_000), "210 MB");
  assert.equal(formatBytes(640_000), "640 KB");
  assert.equal(formatBytes(200), "1 KB");
  assert.equal(formatBytes(0), "0 KB");
  assert.equal(formatBytes(Number.NaN), "—");
});

test("the confirm step names how many clips go and says photos and visits stay", () => {
  const many = confirmQuestion(48, 210_000_000);
  assert.equal(many.question, "Delete 48 clips? This frees about 210 MB.");
  assert.match(many.about, /Photos and visits are kept/);
  const one = confirmQuestion(1, null);
  assert.equal(one.question, "Delete 1 clip?");
  assert.match(one.about, /Photos and visits are kept/);
  assert.equal(clipCount(2), "2 clips");
});

test("the result says what was deleted and what it freed", () => {
  assert.equal(resultLine(48, 210_000_000), "Deleted 48 clips, freed 210 MB");
  assert.equal(resultLine(1, 4_200_000), "Deleted 1 clip, freed 4 MB");
  assert.equal(resultLine(0, 0), "No clips were deleted.");
});

test("the age choices are one month, three, six and one year back", () => {
  assert.deepEqual(AGE_CHOICES.map((choice) => choice.label), ["1 month", "3 months", "6 months", "1 year"]);
  const now = new Date(2026, 9, 8, 12).getTime();
  assert.equal(new Date(cutoff(1, now)).getMonth(), 8);
  assert.equal(new Date(cutoff(12, now)).getFullYear(), 2025);
  assert.ok(cutoff(3, now) < cutoff(1, now));
});

test("a failure is shown as a sentence, an unauthorised one as the administrator rule", () => {
  assert.equal(clipFailure(new Error("The recorder is busy")), "The recorder is busy.");
  assert.equal(clipFailure(Object.assign(new Error("x"), { code: "unauthorized" })), "Only a Home Assistant administrator can delete clips.");
  assert.equal(clipFailure(undefined), "Kestrel couldn't reach its camera recorder.");
});

test("the server's storage answer is read as it is, and missing numbers are zero", () => {
  const answer = { count: 312, bytes: 1_400_000_000, oldestAt: 1_772_000_000_000, byReason: { notAnimal: { count: 9, bytes: 40_000_000 }, unconfirmed: { count: 21, bytes: 90_000_000 } }, canDelete: true };
  assert.deepEqual(clipStorage(answer), answer);
  assert.deepEqual(clipStorage(null), { count: 0, bytes: 0, oldestAt: null, byReason: { notAnimal: { count: 0, bytes: 0 }, unconfirmed: { count: 0, bytes: 0 } }, canDelete: false });
  assert.equal(clipStorage({ ...answer, canDelete: "yes", oldestAt: "soon" }).canDelete, false);
  assert.equal(clipStorage({ ...answer, oldestAt: "soon" }).oldestAt, null);
});
