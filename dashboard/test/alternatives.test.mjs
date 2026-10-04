// Which "Could also be" species a heard visit offers (src/vocab.ts): from what the second listen sent, never more than three, never the visit's own species.
// Node runs the TypeScript files as they are:  cd dashboard && npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { couldAlsoBe, percentSure } from "../src/vocab.ts";

const alt = (species, score, over = {}) => ({ species, scientific: null, score, windowsHigh: 2, window: { start: 1, end: 6 }, ...over });
const visit = (alternatives, over = {}) => ({ kind: "heard", species: "Carolina Wren", status: "auto", audioInfo: { state: "ready", alternatives }, ...over });

test("the species the second listen hears more strongly come back strongest first, as given", () => {
  const list = couldAlsoBe(visit([alt("Barred Owl", 0.27), alt("Great Horned Owl", 0.41), alt("Eastern Screech-Owl", 0.15)]));
  assert.deepEqual(list.map((item) => item.species), ["Great Horned Owl", "Barred Owl", "Eastern Screech-Owl"]);
  assert.deepEqual(list[0], alt("Great Horned Owl", 0.41));
});

test("at most three, or as many as asked for", () => {
  const four = [alt("A", 0.9), alt("B", 0.8), alt("C", 0.7), alt("D", 0.6)];
  assert.equal(couldAlsoBe(visit(four)).length, 3);
  assert.equal(couldAlsoBe(visit(four), 2).length, 2);
});

test("a visit that already is one of them does not offer it, and a species is offered once", () => {
  const list = couldAlsoBe(visit([alt("carolina wren ", 0.6), alt("Barred Owl", 0.5), alt("barred owl", 0.4), alt(" Barred Owl", 0.3)]));
  assert.deepEqual(list.map((item) => item.species), ["Barred Owl"]);
  assert.equal(list[0].score, 0.5);
});

test("a corrected visit offers the others, not the species it was corrected to", () => {
  const list = couldAlsoBe(visit([alt("Barred Owl", 0.5), alt("Great Horned Owl", 0.4)], { species: "Barred Owl", status: "corrected" }));
  assert.deepEqual(list.map((item) => item.species), ["Great Horned Owl"]);
});

test("nothing once a person said the call is right or not an animal, and nothing for a camera visit", () => {
  assert.equal(couldAlsoBe(visit([alt("Barred Owl", 0.5)], { status: "confirmed" })).length, 0);
  assert.equal(couldAlsoBe(visit([alt("Barred Owl", 0.5)], { status: "not_animal" })).length, 0);
  assert.equal(couldAlsoBe(visit([alt("Barred Owl", 0.5)], { status: "unknown" })).length, 1);
  assert.equal(couldAlsoBe(visit([alt("Barred Owl", 0.5)], { kind: "seen" })).length, 0);
});

test("a recording the service has not looked at, or found nothing stronger in, offers nothing", () => {
  assert.deepEqual(couldAlsoBe(visit([])), []);
  for (const audioInfo of [undefined, null, {}, { state: "pending" }, { state: "ready" }, { state: "ready", alternatives: null }, { state: "ready", alternatives: "Barred Owl" }]) {
    assert.deepEqual(couldAlsoBe({ kind: "heard", species: "Carolina Wren", status: "auto", audioInfo }), [], JSON.stringify(audioInfo));
  }
});

test("an entry that cannot be shown is left out and the rest still are", () => {
  const bad = [null, "x", 7, {}, alt("", 0.5), alt("  ", 0.5), alt("No score", undefined), alt("Text score", "0.5"), alt("Too sure", 1.5), alt("Negative", -0.1), alt("Not a number", NaN), alt("Infinite", Infinity)];
  assert.deepEqual(couldAlsoBe(visit([...bad, alt("Barred Owl", 0.3)])).map((item) => item.species), ["Barred Owl"]);
});

test("a visit without a species name still gets its list", () => {
  assert.equal(couldAlsoBe(visit([alt("Barred Owl", 0.3)], { species: undefined })).length, 1);
  assert.equal(couldAlsoBe(visit([alt("Barred Owl", 0.3)], { species: "" })).length, 1);
});

test("a score is shown as a whole percent, kept between 0 and 100", () => {
  assert.equal(percentSure(0.314), "31%");
  assert.equal(percentSure(0.125), "13%");
  assert.equal(percentSure(0), "0%");
  assert.equal(percentSure(1), "100%");
  assert.equal(percentSure(1.4), "100%");
  assert.equal(percentSure(-0.2), "0%");
});
