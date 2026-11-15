// The two Home Assistant cards (src/highlights.ts): what their settings mean, what a highlight says, and which species make the list.
// Node runs the TypeScript files as they are:  cd dashboard && npm test
import assert from "node:assert/strict";
import { test } from "node:test";

const { HIGHLIGHT_SHOWS, KIND_CHOICES, LIST_LIMIT, eyebrow, filterOf, highlightConfig, highlightEmpty, highlightFor, highlightRoute, highlightText, highlightsKey, listConfig, listEvidence, listLast, listRows, listTitle, listVolume, readHighlight, readHighlights, speciesRoute, visitRoute, visitsText } = await import("../src/highlights.ts");

const NOW = Date.UTC(2026, 10, 14, 15, 0, 0);
const MIN = 60_000;
const item = (extra = {}) => ({ species: "Carolina Wren", scientific: "Thryothorus ludovicianus", grp: "bird", kind: "heard", count: 12, total: 80, at: NOW - 3 * MIN, visitId: "v-91", hasPhoto: true, photo_url: "/api/kestrel/media/species/1?authSig=a", referenceImage: null, ...extra });

test("a card with no settings is the latest visit of the last 7 days, both kinds, with everything switched on but the Latin name", () => {
  assert.deepEqual(highlightConfig(undefined), { show: "latest", period: "week", kinds: "both", showName: true, showScientific: false, showTime: true, showCount: true });
  assert.deepEqual(highlightConfig({ type: "custom:kestrel-highlight-card" }), highlightConfig(null));
  assert.deepEqual(listConfig(undefined), { period: "week", limit: 6, kinds: "both" });
});

test("the YAML's names for the settings are read, and anything that is not one of the choices is the default", () => {
  const config = highlightConfig({ show: "most", period: "month", kinds: "heard", show_name: false, show_scientific_name: true, show_time: false, show_count: false });
  assert.deepEqual(config, { show: "most", period: "month", kinds: "heard", showName: false, showScientific: true, showTime: false, showCount: false });
  for (const wrong of ["", "top", "LATEST", 3, null, {}]) assert.equal(highlightConfig({ show: wrong }).show, "latest", String(wrong));
  for (const wrong of ["year", "", 7]) assert.equal(highlightConfig({ period: wrong }).period, "week", String(wrong));
  for (const wrong of ["all", "", false]) assert.equal(highlightConfig({ kinds: wrong }).kinds, "both", String(wrong));
  for (const wrong of ["yes", "false", 0, null]) assert.equal(highlightConfig({ show_name: wrong }).showName, true, `${wrong} is not a yes or a no`);
  assert.deepEqual([...HIGHLIGHT_SHOWS], ["latest", "most", "least"]);
  assert.deepEqual([...KIND_CHOICES], ["both", "seen", "heard"]);
});

test("the list's limit is a whole number of rows between 1 and 24", () => {
  assert.equal(listConfig({ limit: 3 }).limit, 3);
  assert.equal(listConfig({ limit: "4" }).limit, 4, "a number typed in quotes still counts");
  assert.equal(listConfig({ limit: 2.6 }).limit, 3);
  assert.equal(listConfig({ limit: 0 }).limit, LIST_LIMIT.min);
  assert.equal(listConfig({ limit: -5 }).limit, LIST_LIMIT.min);
  assert.equal(listConfig({ limit: 500 }).limit, LIST_LIMIT.max);
  for (const wrong of ["many", NaN, Infinity, null, undefined, {}]) assert.equal(listConfig({ limit: wrong }).limit, LIST_LIMIT.fallback, String(wrong));
  assert.deepEqual(listConfig({ period: "today", kinds: "seen", limit: 8 }), { period: "today", limit: 8, kinds: "seen" });
});

test("a highlight is read from the server's answer, and one that names no species or no kind of visit is nothing", () => {
  const read = readHighlight(item());
  assert.equal(read.species, "Carolina Wren");
  assert.equal(read.scientific, "Thryothorus ludovicianus");
  assert.equal(read.kind, "heard");
  assert.equal(read.count, 12);
  assert.equal(read.total, 80);
  assert.equal(read.at, NOW - 3 * MIN);
  assert.equal(read.visitId, "v-91");
  assert.equal(read.photo_url, "/api/kestrel/media/species/1?authSig=a");
  assert.equal(read.referenceImage, null);
  for (const bad of [null, undefined, 4, "wren", {}, item({ species: "" }), item({ species: "  " }), item({ kind: "smelled" }), item({ kind: undefined })]) assert.equal(readHighlight(bad), null, JSON.stringify(bad));
});

test("a highlight with parts missing is still a highlight, with nothing made up for them", () => {
  const bare = readHighlight({ species: "Blue Jay", kind: "seen" });
  assert.deepEqual(bare, { species: "Blue Jay", scientific: null, grp: "unknown", kind: "seen", count: 0, total: 0, at: null, visitId: null, photo_url: null, referenceImage: null });
  assert.equal(readHighlight(item({ visitId: 4417 })).visitId, "4417", "a numeric visit id is its text");
  assert.equal(readHighlight(item({ visitId: null })).visitId, null);
  assert.equal(readHighlight(item({ grp: "fish" })).grp, "unknown");
  assert.equal(readHighlight(item({ grp: "mammal" })).grp, "mammal");
  assert.equal(readHighlight(item({ count: 9, total: 2 })).total, 9, "it cannot have had fewer visits ever than in the period");
  assert.equal(readHighlight(item({ count: -3, total: "many" })).count, 0);
  assert.equal(readHighlight(item({ scientific: "  " })).scientific, null);
  assert.equal(readHighlight(item({ at: "2026-11-14T14:57:00Z" })).at, Date.parse("2026-11-14T14:57:00Z"));
  assert.equal(readHighlight(item({ at: "yesterday" })).at, null);
});

test("the three highlights come out as latest, most and least", () => {
  const answer = { period: "week", kind: "both", latest: item({ species: "A" }), top: item({ species: "B" }), rare: null };
  const highlights = readHighlights(answer);
  assert.equal(highlightFor(highlights, "latest").species, "A");
  assert.equal(highlightFor(highlights, "most").species, "B");
  assert.equal(highlightFor(highlights, "least"), null);
  assert.deepEqual(readHighlights(undefined), { latest: null, top: null, rare: null });
  assert.deepEqual(readHighlights("nothing"), { latest: null, top: null, rare: null });
});

test("cards that ask the same question share one answer", () => {
  assert.equal(highlightsKey("week", "both"), highlightsKey("week", "both"));
  assert.notEqual(highlightsKey("week", "both"), highlightsKey("week", "heard"));
  assert.notEqual(highlightsKey("week", "both"), highlightsKey("today", "both"));
});

test("the line above the name says what is shown and over what time", () => {
  assert.equal(eyebrow("latest", "today", "both"), "Latest · Today");
  assert.equal(eyebrow("latest", "all", "heard"), "Latest heard · All time");
  assert.equal(eyebrow("most", "week", "heard"), "Most heard · 7 days");
  assert.equal(eyebrow("most", "week", "seen"), "Most seen · 7 days");
  assert.equal(eyebrow("most", "month", "both"), "Most frequent · 30 days");
  assert.equal(eyebrow("least", "month", "both"), "Least frequent · 30 days");
  assert.equal(eyebrow("least", "today", "heard"), "Least heard · Today");
});

test("a count of visits is in the words of the kind being counted", () => {
  assert.equal(visitsText(12, "both"), "12 visits");
  assert.equal(visitsText(1, "both"), "1 visit");
  assert.equal(visitsText(12, "heard"), "12 recordings");
  assert.equal(visitsText(1, "heard"), "1 recording");
  assert.equal(visitsText(3, "seen"), "3 videos");
  assert.equal(visitsText(0, "both"), null);
});

test("the card's words follow its switches, while the label for a screen reader always has the whole story", () => {
  const config = highlightConfig({ show: "most", period: "week", kinds: "heard" });
  const all = highlightText(item(), { ...config, showScientific: true }, NOW);
  assert.deepEqual({ ...all, label: undefined }, { eyebrow: "Most heard · 7 days", name: "Carolina Wren", scientific: "Thryothorus ludovicianus", time: "Heard 3 min ago", count: "12 recordings", label: undefined });
  assert.equal(all.label, "Most heard · 7 days. Carolina Wren. Heard 3 min ago. 12 recordings");
  const bare = highlightText(item(), { ...config, showName: false, showScientific: false, showTime: false, showCount: false }, NOW);
  assert.deepEqual({ name: bare.name, scientific: bare.scientific, time: bare.time, count: bare.count }, { name: null, scientific: null, time: null, count: null });
  assert.equal(bare.label, all.label, "hiding things from the picture hides nothing from someone who cannot see it");
  assert.equal(highlightText(item({ scientific: null }), { ...config, showScientific: true }, NOW).scientific, null);
  assert.equal(highlightText(item({ at: null }), config, NOW).time, null);
  assert.equal(highlightText(item({ kind: "seen" }), config, NOW).time, "Seen 3 min ago");
});

test("a tap on the latest visit opens that visit; anything else opens the species", () => {
  assert.equal(highlightRoute(item(), "latest"), "/kestrel/visit?v=v-91");
  assert.equal(highlightRoute(item({ visitId: null }), "latest"), "/kestrel/wildlife?s=Carolina%20Wren");
  assert.equal(highlightRoute(item(), "most"), "/kestrel/wildlife?s=Carolina%20Wren");
  assert.equal(highlightRoute(item(), "least"), "/kestrel/wildlife?s=Carolina%20Wren");
  assert.equal(speciesRoute("Black-capped Chickadee"), "/kestrel/wildlife?s=Black-capped%20Chickadee");
  assert.equal(speciesRoute("Steller's Jay & friends"), "/kestrel/wildlife?s=Steller's%20Jay%20%26%20friends", "an & inside a name stays inside the name");
  assert.equal(visitRoute("a/b c"), "/kestrel/visit?v=a%2Fb%20c");
  assert.equal(new URL(speciesRoute("Steller's Jay & friends"), "http://ha.local").searchParams.get("s"), "Steller's Jay & friends");
});

test("when nothing qualifies the card says what the Wildlife list says", () => {
  assert.equal(highlightEmpty({ period: "today", kinds: "heard" }), "Nothing heard today");
  assert.equal(highlightEmpty({ period: "week", kinds: "both" }), "No wildlife in the last 7 days");
  assert.equal(highlightEmpty({ period: "all", kinds: "seen" }), "Nothing on camera yet");
  assert.equal(filterOf("both"), "all");
  assert.equal(filterOf("seen"), "seen");
});

// ---- the list ----

const wren = { species: "Carolina Wren", seen: true, heard: true, seenCount30d: 4, heardCount30d: 20, periodCount: 9, periodSeen: 2, periodHeard: 7, lastSeenAt: NOW - 50 * MIN, lastHeardAt: NOW - 3 * MIN };
const jay = { species: "Blue Jay", seen: true, heard: false, seenCount30d: 3, heardCount30d: 0, periodCount: 3, periodSeen: 3, periodHeard: 0, lastSeenAt: NOW - 10 * MIN };
const owl = { species: "Barred Owl", seen: false, heard: true, seenCount30d: 0, heardCount30d: 1, periodCount: 3, periodSeen: 0, periodHeard: 3, lastHeardAt: NOW - 20 * MIN };
const robin = { species: "Robin", seen: true, heard: true, seenCount30d: 1, heardCount30d: 0, periodCount: 0, periodSeen: 0, periodHeard: 0 };
const all = [jay, owl, robin, wren];

test("the list is the busiest species first, and among equals the one the server listed first (the newest)", () => {
  assert.deepEqual(listRows(all, listConfig({ limit: 10 })).map((each) => each.species), ["Carolina Wren", "Blue Jay", "Barred Owl"]);
  assert.deepEqual(listRows([owl, jay], listConfig({ limit: 10 })).map((each) => each.species), ["Barred Owl", "Blue Jay"], "three each: the server's order stands");
  assert.deepEqual(listRows([jay, owl], listConfig({ limit: 10 })).map((each) => each.species), ["Blue Jay", "Barred Owl"]);
});

test("a species with no visit in the period is not in the list", () => {
  assert.equal(listRows(all, listConfig({ period: "week" })).some((each) => each.species === "Robin"), false);
});

test("the limit cuts the list, and the cards' own copy of the list is never reordered", () => {
  const copy = [...all];
  assert.deepEqual(listRows(all, listConfig({ limit: 2 })).map((each) => each.species), ["Carolina Wren", "Blue Jay"]);
  assert.deepEqual(all, copy);
});

test("a card about one kind counts and lists only that kind", () => {
  assert.deepEqual(listRows(all, listConfig({ kinds: "heard", limit: 10 })).map((each) => each.species), ["Carolina Wren", "Barred Owl"], "the jay was never heard");
  assert.deepEqual(listRows(all, listConfig({ kinds: "seen", limit: 10 })).map((each) => each.species), ["Blue Jay", "Carolina Wren"], "3 seen beats 2 seen");
  assert.equal(listVolume(wren, "both"), 9);
  assert.equal(listVolume(wren, "heard"), 7);
  assert.equal(listVolume(wren, "seen"), 2);
});

test("a server that sends no period counts is read from the 30-day counts", () => {
  const old = { species: "Robin", seen: true, heard: true, seenCount30d: 5, heardCount30d: 6 };
  assert.equal(listVolume(old, "both"), 11);
  assert.deepEqual(listRows([old], listConfig({ period: "all" })).map((each) => each.species), ["Robin"]);
});

test("the counts at the end of a row are the kinds the card is about", () => {
  assert.deepEqual(listEvidence(wren, listConfig({})), [{ kind: "seen", count: 2 }, { kind: "heard", count: 7 }]);
  assert.deepEqual(listEvidence(wren, listConfig({ kinds: "heard" })), [{ kind: "heard", count: 7 }]);
  assert.deepEqual(listEvidence(jay, listConfig({})), [{ kind: "seen", count: 3 }]);
  assert.deepEqual(listEvidence(owl, listConfig({ kinds: "seen" })), []);
});

test("a row says when the species last turned up, in the kinds the card is about", () => {
  assert.equal(listLast(wren, "both", NOW), "Heard 3 min ago");
  assert.equal(listLast(wren, "seen", NOW), "Seen 50 min ago");
  assert.equal(listLast(wren, "heard", NOW), "Heard 3 min ago");
  assert.equal(listLast(jay, "heard", NOW), null);
  assert.equal(listLast({ species: "Ghost" }, "both", NOW), null);
  assert.equal(listLast({ species: "Old", seen: true, heard: false, last: NOW - 5 * MIN }, "both", NOW), "Seen 5 min ago");
});

test("the list card's heading is the period", () => {
  assert.equal(listTitle("week"), "Wildlife · 7 days");
  assert.equal(listTitle("all"), "Wildlife · All time");
});
