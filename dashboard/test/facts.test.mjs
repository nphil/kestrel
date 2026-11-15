import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CREDIT, addDays, dayBars, dayCaption, dayChartLabel, dayLabel, factRows, isoDay, newChip, speciesFacts, trimBlurb } from "../src/facts.ts";

const full = {
  perDay: [0, 1, 0, 4, 2.4, -3, "x"],
  perDayFrom: "2026-11-08",
  firstAt: 1_790_000_000_000,
  lastAt: 1_790_500_000_000,
  bestScore: 0.912,
  bestVisitId: "v-9",
  newThisSeason: true,
  newToHome: false,
  scientific: " Thryothorus ludovicianus ",
  description: "The Carolina wren is a common wren.\n It lives in the south.",
  descriptionSource: { name: "Wikipedia", url: "https://en.wikipedia.org/wiki/Carolina_wren", licence: "CC BY-SA 4.0", licenceUrl: "https://creativecommons.org/licenses/by-sa/4.0/" },
};

test("speciesFacts reads every new field from the top of the answer", () => {
  const facts = speciesFacts(full);
  assert.deepEqual(facts.perDay, [0, 1, 0, 4, 2, 0, 0]);
  assert.equal(facts.perDayFrom, "2026-11-08");
  assert.equal(facts.firstAt, 1_790_000_000_000);
  assert.equal(facts.lastAt, 1_790_500_000_000);
  assert.equal(facts.bestScore, 0.912);
  assert.equal(facts.bestVisitId, "v-9");
  assert.equal(facts.newThisSeason, true);
  assert.equal(facts.newToHome, false);
  assert.equal(facts.scientific, "Thryothorus ludovicianus");
  assert.equal(facts.description, "The Carolina wren is a common wren. It lives in the south.");
  assert.deepEqual(facts.credit, { name: "Wikipedia", url: "https://en.wikipedia.org/wiki/Carolina_wren", licence: "CC BY-SA 4.0", licenceUrl: "https://creativecommons.org/licenses/by-sa/4.0/" });
});

test("speciesFacts falls back to a nested species and survives rubbish", () => {
  assert.equal(speciesFacts({ species: { bestVisitId: "inner", newToHome: true } }).bestVisitId, "inner");
  assert.equal(speciesFacts({ species: { newToHome: true } }).newToHome, true);
  for (const junk of [null, undefined, 7, "text", [], { perDay: "no", bestScore: "high", description: 5, descriptionSource: 3, firstAt: {}, bestVisitId: "" }]) {
    const facts = speciesFacts(junk);
    assert.deepEqual(facts.perDay, []);
    assert.equal(facts.perDayFrom, null);
    assert.equal(facts.firstAt, null);
    assert.equal(facts.bestScore, null);
    assert.equal(facts.bestVisitId, null);
    assert.equal(facts.newThisSeason, false);
    assert.equal(facts.newToHome, false);
    assert.equal(facts.scientific, null);
    assert.equal(facts.description, null);
    assert.equal(facts.credit, null);
  }
});

test("speciesFacts keeps only https links, never trusts a score outside 0 to 1, and drops a credit without a description", () => {
  const facts = speciesFacts({ description: "A bird.", descriptionSource: { url: "javascript:alert(1)", licenceUrl: "http://example.com/x", licence: "CC BY-SA 4.0" }, bestScore: 87 });
  assert.deepEqual(facts.credit, { name: "Wikipedia", url: null, licence: "CC BY-SA 4.0", licenceUrl: null });
  assert.equal(facts.bestScore, 1);
  assert.equal(speciesFacts({ descriptionSource: { name: "Wikipedia", url: "https://en.wikipedia.org/wiki/X" } }).credit, null);
  assert.equal(speciesFacts({ description: "A bird." }).credit, null);
  assert.equal(DEFAULT_CREDIT.licence, "CC BY-SA 4.0");
});

test("trimBlurb leaves a short text alone and cuts a long one at a sentence", () => {
  assert.equal(trimBlurb("Short."), "Short.");
  const sentence = "A sentence that is a little long. ";
  const long = sentence.repeat(40).trim();
  const cut = trimBlurb(long, 100);
  assert.ok(cut.length <= 100);
  assert.ok(cut.endsWith("."), cut);
  const noStops = trimBlurb("word ".repeat(80).trim(), 50);
  assert.ok(noStops.endsWith("…") && noStops.length <= 51, noStops);
});

test("addDays is plain calendar arithmetic across months, years and clock changes", () => {
  assert.equal(addDays("2026-10-16", 29), "2026-11-14");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2026-03-08", 1), "2026-03-09");
  assert.equal(addDays("2026-11-01", 1), "2026-11-02");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(addDays("2028-03-01", -1), "2028-02-29");
});

test("isoDay is this device's calendar date", () => {
  assert.equal(isoDay(new Date(2026, 10, 14, 23, 59).getTime()), "2026-11-14");
  assert.equal(isoDay(new Date(2026, 0, 3, 0, 1).getTime()), "2026-01-03");
  assert.match(dayLabel("2026-11-03"), /3/);
});

test("dayBars dates every bar from perDayFrom and calls the last one Today", () => {
  const perDay = Array.from({ length: 30 }, (_, index) => (index === 3 ? 4 : index === 29 ? 4 : index % 5 === 0 ? 1 : 0));
  const days = dayBars({ perDay, perDayFrom: "2026-10-16" });
  assert.equal(days.bars.length, 30);
  assert.equal(days.bars[0].date, "2026-10-16");
  assert.equal(days.bars[29].date, "2026-11-14");
  assert.equal(days.bars[29].label, "Today");
  assert.notEqual(days.bars[28].label, "Today");
  assert.equal(days.total, perDay.reduce((sum, count) => sum + count, 0));
  assert.equal(days.busiest.date, "2026-11-14", "a tie goes to the latest day");
  assert.match(dayCaption(days), /^\d+ visits in the last 30 days · busiest today \(4\)$/);
  assert.match(dayChartLabel(days), /^Visits per day, last 30 days\. .* today \(4\)\.$/);
});

test("dayBars without perDayFrom counts back from this device's today", () => {
  const now = new Date(2026, 10, 14, 15, 0).getTime();
  const days = dayBars({ perDay: [2, 0, 1], perDayFrom: null }, now);
  assert.deepEqual(days.bars.map((bar) => bar.date), ["2026-11-12", "2026-11-13", "2026-11-14"]);
  assert.equal(days.busiest.count, 2);
  assert.match(dayCaption(days), /^3 visits in the last 3 days · busiest .+ \(2\)$/);
});

test("dayBars with no days or no visits has nothing to name", () => {
  assert.deepEqual(dayBars({ perDay: [], perDayFrom: null }).bars, []);
  const empty = dayBars({ perDay: [0, 0], perDayFrom: "2026-11-13" });
  assert.equal(empty.busiest, null);
  assert.equal(empty.total, 0);
  assert.equal(dayCaption(empty), "0 visits in the last 2 days");
  assert.equal(dayCaption(dayBars({ perDay: [1], perDayFrom: "2026-11-14" })), "1 visit in the last 1 days · busiest today (1)");
});

const now = new Date(2026, 10, 14, 15, 0).getTime();
const heardOnly = { seen: false, heard: true, first: "2026-11-01T10:00:00Z", last: "2026-11-14T14:55:00Z" };

test("factRows uses the species list's own times until the answer is in, and says heard, seen or detected", () => {
  const rows = factRows(heardOnly, null, now);
  assert.deepEqual(rows.map((row) => [row.key, row.label]), [["first", "First heard"], ["last", "Last heard"]]);
  assert.ok(rows.every((row) => row.value && row.visitId === null));
  assert.equal(factRows({ ...heardOnly, heard: false, seen: true }, null, now)[0].label, "First seen");
  assert.equal(factRows({ ...heardOnly, seen: true }, null, now)[0].label, "First detected");
  assert.deepEqual(factRows({ seen: true, heard: false, first: null, last: null }, null, now), []);
});

test("factRows prefers the answer's moments and adds the surest ID with its visit", () => {
  const facts = speciesFacts(full);
  const rows = factRows(heardOnly, facts, now);
  assert.deepEqual(rows.map((row) => row.key), ["first", "last", "best"]);
  const best = rows[2];
  assert.equal(best.label, "Surest ID");
  assert.equal(best.value, "91% sure");
  assert.equal(best.visitId, "v-9");
  assert.equal(factRows(heardOnly, speciesFacts({ bestScore: 0.5 }), now)[2].visitId, null, "no visit to open: the row only tells");
  assert.equal(factRows(heardOnly, speciesFacts({ bestScore: 0 }), now).length, 2, "a score of nothing is not a fact");
});

test("newChip names the most specific newness only", () => {
  const year = { newThisYear: true };
  assert.deepEqual(newChip(year, { newThisSeason: true, newToHome: true }), { label: "New to your home", icon: "mdi:home-plus-outline" });
  assert.equal(newChip(year, { newThisSeason: true, newToHome: false }).label, "New this season");
  assert.equal(newChip(year, { newThisSeason: false, newToHome: false }).label, "New this year");
  assert.equal(newChip(year, null).label, "New this year");
  assert.equal(newChip({ newThisYear: false }, { newThisSeason: false, newToHome: false }), null);
  assert.equal(newChip({ newThisYear: false }, null), null);
});
