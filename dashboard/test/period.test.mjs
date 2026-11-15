// The Wildlife period switch (src/period.ts and the period parts of src/wildlife.ts): what is stored, what a tile counts, what an empty list says.
// Node runs the TypeScript files as they are:  cd dashboard && npm test
import assert from "node:assert/strict";
import { test } from "node:test";

const storage = new Map();
globalThis.window = { sessionStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, String(value)); } } };

const { DEFAULT_PERIOD, PERIODS, PERIOD_LABEL, PERIOD_PHRASE, asPeriod } = await import("../src/period.ts");
const { emptyWildlife, filterCounts, inPeriod, matchesFilter, rememberPeriod, rememberedPeriod, tileCount, tileEvidence } = await import("../src/wildlife.ts");

const wren = { species: "Carolina Wren", seen: true, heard: true, seenCount30d: 4, heardCount30d: 20, periodCount: 9, periodSeen: 2, periodHeard: 7 };
const jay = { species: "Blue Jay", seen: true, heard: false, seenCount30d: 3, heardCount30d: 0, periodCount: 3, periodSeen: 3, periodHeard: 0 };
const owl = { species: "Barred Owl", seen: false, heard: true, seenCount30d: 0, heardCount30d: 1, periodCount: 0, periodSeen: 0, periodHeard: 0 };
const oldServer = { species: "Robin", seen: true, heard: true, seenCount30d: 5, heardCount30d: 6 };

test("the four periods are today, 7 days, 30 days and all time, and all time is where everybody starts", () => {
  assert.deepEqual([...PERIODS], ["today", "week", "month", "all"]);
  assert.equal(DEFAULT_PERIOD, "all");
  assert.deepEqual(PERIODS.map((period) => PERIOD_LABEL[period]), ["Today", "7 days", "30 days", "All time"]);
});

test("a period that is not one of the four is read as the fallback", () => {
  for (const value of [undefined, null, "", "year", "TODAY", 7, {}, ["week"]]) assert.equal(asPeriod(value), "all", String(value));
  assert.equal(asPeriod("year", "week"), "week");
  for (const period of PERIODS) assert.equal(asPeriod(period), period);
});

test("the period reads in the middle of a sentence", () => {
  assert.equal(`Nothing heard ${PERIOD_PHRASE.today}`, "Nothing heard today");
  assert.equal(`Nothing heard ${PERIOD_PHRASE.week}`, "Nothing heard in the last 7 days");
  assert.equal(`Nothing heard ${PERIOD_PHRASE.month}`, "Nothing heard in the last 30 days");
});

test("inside a period, on camera and heard mean 'in that period'; at all time they mean 'ever'", () => {
  assert.equal(matchesFilter(wren, "seen", "week"), true);
  assert.equal(matchesFilter(jay, "heard", "week"), false);
  assert.equal(matchesFilter({ ...jay, periodSeen: 0, seen: true }, "seen", "today"), false, "seen last month is not seen today");
  assert.equal(matchesFilter({ ...jay, periodHeard: 0, heard: true }, "heard", "all"), true, "all time still reads the all-time flag");
  assert.equal(matchesFilter(owl, "all", "week"), true);
});

test("a server that sends no period numbers is read by its all-time flags", () => {
  assert.equal(matchesFilter(oldServer, "seen", "week"), true);
  assert.equal(matchesFilter({ ...oldServer, heard: false }, "heard", "week"), false);
});

test("the filter counts follow the period", () => {
  assert.deepEqual(filterCounts([wren, jay], "week"), { all: 2, seen: 2, heard: 1 });
  assert.deepEqual(filterCounts([wren, jay, owl], "all"), { all: 3, seen: 2, heard: 2 });
});

test("a period keeps the species that had a visit in it; all time keeps everyone", () => {
  assert.deepEqual(inPeriod([wren, jay, owl], "today").map((item) => item.species), ["Carolina Wren", "Blue Jay"]);
  assert.deepEqual(inPeriod([wren, jay, owl], "all").map((item) => item.species), ["Carolina Wren", "Blue Jay", "Barred Owl"]);
  assert.deepEqual(inPeriod([oldServer], "week"), [], "without a period count there is nothing to say it was there");
});

test("a tile counts the period's own number, and falls back to the last 30 days", () => {
  assert.equal(tileCount(wren, "seen"), 2);
  assert.equal(tileCount(wren, "heard"), 7);
  assert.equal(tileCount(oldServer, "seen"), 5);
  assert.equal(tileCount({ ...oldServer, seenCount30d: undefined }, "seen"), undefined);
  assert.equal(tileCount({ ...wren, periodHeard: -1 }, "heard"), 20, "a number that makes no sense is not used");
});

test("a tile shows one badge per kind that happened in the period", () => {
  assert.deepEqual(tileEvidence(wren, "week"), [{ kind: "seen", count: 2 }, { kind: "heard", count: 7 }]);
  assert.deepEqual(tileEvidence(jay, "week"), [{ kind: "seen", count: 3 }]);
  assert.deepEqual(tileEvidence({ ...wren, periodSeen: 0 }, "today"), [{ kind: "heard", count: 7 }]);
});

test("an empty list says what is missing and where to look next", () => {
  assert.deepEqual(emptyWildlife("today", "seen"), { kind: "seen", heading: "Nothing on camera today", message: "No camera caught an animal today.", action: "all-time" });
  assert.equal(emptyWildlife("week", "heard").heading, "Nothing heard in the last 7 days");
  assert.equal(emptyWildlife("month", "all").heading, "No wildlife in the last 30 days");
  assert.equal(emptyWildlife("month", "all").message, "No animals were seen or heard in the last 30 days.");
  for (const filter of ["all", "seen", "heard"]) assert.equal(emptyWildlife("today", filter).action, "all-time", filter);
});

test("at all time the empty copy is the one the panel always had", () => {
  assert.equal(emptyWildlife("all", "seen").heading, "Nothing on camera yet");
  assert.equal(emptyWildlife("all", "heard").heading, "Nothing heard yet");
  assert.equal(emptyWildlife("all", "seen").action, "all-species");
  assert.equal(emptyWildlife("all", "all").action, null);
});

test("the chosen period is kept for the browser session", () => {
  assert.equal(rememberedPeriod(), "all", "nothing stored: all time");
  rememberPeriod("week");
  assert.equal(rememberedPeriod(), "week");
  assert.equal(storage.get("kestrel.wildlife.period"), "week");
});

test("a stored period nobody can read is ignored", async () => {
  storage.set("kestrel.wildlife.period", "last-century");
  const fresh = await import("../src/wildlife.ts?fresh");
  assert.equal(fresh.rememberedPeriod(), "all");
});
