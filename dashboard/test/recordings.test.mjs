import test from "node:test";
import assert from "node:assert/strict";
import { PICTURE_RETRY_MS, forgetExtras, knownExtras, loadExtras, pictureRetryDelay, readExtras, readWeather, weatherText } from "../src/recordings.ts";

test("readWeather tidies a normal answer", () => {
  const weather = readWeather({ temp: 8.4, unit: "°C", conditions: "  Clear sky ", icon: "mdi:weather-night" });
  assert.deepEqual(weather, { temp: 8, unit: "°C", conditions: "Clear sky", icon: "mdi:weather-night" });
  assert.equal(weatherText(weather), "8°C · Clear sky");
  assert.equal(readWeather({ temp: -2.6, unit: "F", conditions: "Snow", icon: "mdi:weather-snowy" }).unit, "°F");
  assert.equal(weatherText(readWeather({ temp: -2.6, unit: "°F", conditions: "Snow" })), "-3°F · Snow");
});

test("readWeather keeps what it can and refuses what it cannot trust", () => {
  assert.deepEqual(readWeather({ temp: 12, unit: "kelvin", conditions: "", icon: "javascript:1" }), { temp: 12, unit: "°", conditions: "", icon: "mdi:weather-partly-cloudy" });
  assert.equal(weatherText(readWeather({ temp: 12, unit: "kelvin" })), "12°");
  assert.equal(weatherText(readWeather({ conditions: "Fog", temp: "cold" })), "Fog");
  assert.equal(readWeather({ icon: "mdi:weather-night" }), null, "neither a temperature nor words is no weather");
  for (const junk of [null, undefined, 5, "warm", [], { temp: Number.NaN }]) assert.equal(readWeather(junk), null);
  assert.equal(readWeather({ conditions: "x".repeat(200) }).conditions.length, 60);
});

test("readExtras maps every answered id and leaves missing parts null", () => {
  const read = readExtras({ items: {
    a: { weather: { temp: 3, unit: "°C", conditions: "Rain", icon: "mdi:weather-rainy" }, spectrogram: "/api/kestrel/media/birdnet_spectrogram/7?authSig=abc" },
    b: { weather: null, spectrogram: null },
    c: "garbage",
    d: { spectrogram: "   " },
  } });
  assert.deepEqual(Object.keys(read), ["a", "b", "c", "d"]);
  assert.equal(read.a.spectrogram, "/api/kestrel/media/birdnet_spectrogram/7?authSig=abc");
  assert.equal(read.a.weather.conditions, "Rain");
  assert.deepEqual(read.b, { weather: null, spectrogram: null });
  assert.deepEqual(read.c, { weather: null, spectrogram: null });
  assert.equal(read.d.spectrogram, null);
  for (const junk of [null, undefined, 3, "x", [], {}, { items: null }, { items: 4 }]) assert.deepEqual(readExtras(junk), {});
});

const answer = (ids) => ({ items: Object.fromEntries(ids.map((id) => [id, { weather: null, spectrogram: `/api/kestrel/media/birdnet_spectrogram/${id}?authSig=s` }])) });

test("loadExtras asks once per id, twenty at a time, and remembers the answers", async () => {
  forgetExtras();
  const asked = [];
  const ask = async (ids) => { asked.push(ids); return answer(ids); };
  const ids = Array.from({ length: 45 }, (_, index) => `v${index}`);
  await loadExtras(ask, [...ids, "v0", ""]);
  assert.deepEqual(asked.map((batch) => batch.length), [20, 20, 5]);
  assert.equal(knownExtras("v44").spectrogram, "/api/kestrel/media/birdnet_spectrogram/v44?authSig=s");
  await loadExtras(ask, ids);
  assert.equal(asked.length, 3, "nothing is asked twice");
});

test("loadExtras shares a question already on its way", async () => {
  forgetExtras();
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const ask = async (ids) => { calls += 1; await gate; return answer(ids); };
  const first = loadExtras(ask, ["a", "b"]);
  const second = loadExtras(ask, ["b", "c"]);
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 2, "b was not asked about again; c was asked about separately");
  assert.ok(knownExtras("a") && knownExtras("b") && knownExtras("c"));
});

test("a failed ask is not remembered, so the next one tries again", async () => {
  forgetExtras();
  await loadExtras(async () => { throw new Error("offline"); }, ["z"]);
  assert.equal(knownExtras("z"), undefined);
  await loadExtras(async (ids) => answer(ids), ["z"]);
  assert.ok(knownExtras("z"));
});

test("an id the answer left out is remembered as having nothing", async () => {
  forgetExtras();
  await loadExtras(async () => ({ items: {} }), ["q"]);
  assert.deepEqual(knownExtras("q"), { weather: null, spectrogram: null });
});

test("answers expire: a spectrogram after 30 minutes, a missing one after two", async () => {
  forgetExtras();
  await loadExtras(async () => ({ items: { has: { spectrogram: "/api/x?authSig=1" }, none: { spectrogram: null } } }), ["has", "none"]);
  const soon = Date.now() + 3 * 60_000;
  assert.equal(knownExtras("none", soon), undefined);
  assert.ok(knownExtras("has", soon));
  assert.equal(knownExtras("has", Date.now() + 31 * 60_000), undefined);
});

test("forgetExtras empties the memory", async () => {
  await loadExtras(async (ids) => answer(ids), ["k"]);
  assert.ok(knownExtras("k"));
  forgetExtras();
  assert.equal(knownExtras("k"), undefined);
});

test("a picture that is not ready is asked for again after two seconds, then after longer and longer pauses, then given up on", () => {
  const pauses = [];
  for (let retries = 0; pictureRetryDelay(retries) !== null; retries += 1) pauses.push(pictureRetryDelay(retries));
  assert.deepEqual(pauses, [2_000, 15_000, 45_000, 120_000, 300_000]);
  assert.equal(pictureRetryDelay(PICTURE_RETRY_MS.length), null);
  assert.equal(pictureRetryDelay(50), null);
});

test("the pauses only grow, and a sheet left open stops asking within ten minutes", () => {
  assert.deepEqual([...PICTURE_RETRY_MS], [...PICTURE_RETRY_MS].sort((a, b) => a - b));
  assert.ok(PICTURE_RETRY_MS[0] <= 5_000, "the first retry comes quickly: BirdNET-Go is usually still drawing the picture when the server stops waiting");
  assert.ok(PICTURE_RETRY_MS.reduce((total, pause) => total + pause, 0) < 10 * 60_000);
});

test("a count that makes no sense gives up instead of asking for ever", () => {
  for (const nonsense of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(pictureRetryDelay(nonsense), null, String(nonsense));
});
