// The small keep-the-newest map a tab uses for what it remembers between visits to a page (src/lru.ts).
// Node runs the TypeScript files as they are:  cd dashboard && npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { Lru } from "../src/lru.ts";

const keys = (lru) => [...lru.values()];

test("it keeps at most `limit` entries and forgets the one unused longest", () => {
  const lru = new Lru(3);
  for (const key of ["a", "b", "c", "d", "e"]) lru.set(key, key.toUpperCase());
  assert.equal(lru.size, 3);
  assert.deepEqual(keys(lru), ["C", "D", "E"]);
  assert.equal(lru.get("a"), undefined);
  assert.equal(lru.get("b"), undefined);
});

test("reading an entry makes it the newest, so what is looked at again outlives what is not", () => {
  const lru = new Lru(3);
  lru.set("a", 1).set("b", 2).set("c", 3);
  assert.equal(lru.get("a"), 1); // a is now the newest; b has gone unused the longest
  lru.set("d", 4);
  assert.equal(lru.get("b"), undefined);
  assert.deepEqual(keys(lru), [3, 1, 4]);
});

test("setting a key that is already there replaces it and makes it the newest, without growing", () => {
  const lru = new Lru(2);
  lru.set("a", 1).set("b", 2).set("a", 10);
  assert.equal(lru.size, 2);
  assert.deepEqual(keys(lru), [2, 10]);
  lru.set("c", 3); // b is the one unused longest
  assert.equal(lru.get("b"), undefined);
  assert.equal(lru.get("a"), 10);
});

test("looking at the values does not make any of them newer", () => {
  const lru = new Lru(2);
  lru.set("a", 1).set("b", 2);
  assert.deepEqual(keys(lru), [1, 2]);
  assert.deepEqual(keys(lru), [1, 2]);
  lru.set("c", 3);
  assert.equal(lru.get("a"), undefined, "a was still the oldest");
});

test("an entry can be dropped and the whole lot cleared", () => {
  const lru = new Lru(5);
  lru.set("a", 1).set("b", 2);
  assert.equal(lru.delete("a"), true);
  assert.equal(lru.delete("a"), false);
  assert.equal(lru.get("a"), undefined);
  lru.clear();
  assert.equal(lru.size, 0);
  assert.deepEqual(keys(lru), []);
});

test("a map that could keep nothing is refused", () => {
  for (const limit of [0, -1, 1.5, Number.NaN]) assert.throws(() => new Lru(limit), RangeError, String(limit));
  assert.equal(new Lru(1).set("a", 1).set("b", 2).size, 1);
});
