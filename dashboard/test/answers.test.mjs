// What a dashboard card does so that an answer that has not changed is not drawn again (src/answers.ts).
// Node runs the TypeScript files as they are:  cd dashboard && npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { drawnDifferently, steadyAnswer } from "../src/answers.ts";

test("an answer that says the same as the last one comes back as that very object", () => {
  const first = [{ species: "Barred Owl", count: 3 }];
  const again = [{ species: "Barred Owl", count: 3 }];
  assert.notEqual(first, again);
  assert.equal(steadyAnswer("steady:same", first), first);
  assert.equal(steadyAnswer("steady:same", again), first);
});

test("an answer that says something new is used, and is what the next one is compared with", () => {
  const first = [{ species: "Barred Owl", count: 3 }];
  const second = [{ species: "Barred Owl", count: 4 }];
  const third = [{ species: "Barred Owl", count: 4 }];
  assert.equal(steadyAnswer("steady:new", first), first);
  assert.equal(steadyAnswer("steady:new", second), second);
  assert.equal(steadyAnswer("steady:new", third), second);
});

test("going back to what an older answer said counts as new: only the last answer is the one on screen", () => {
  const a = { n: 1 };
  const b = { n: 2 };
  const a2 = { n: 1 };
  steadyAnswer("steady:back", a);
  steadyAnswer("steady:back", b);
  assert.equal(steadyAnswer("steady:back", a2), a2);
});

test("every question is compared only with its own last answer", () => {
  const week = { n: 1 };
  const month = { n: 1 };
  assert.equal(steadyAnswer("steady:week", week), week);
  assert.equal(steadyAnswer("steady:month", month), month);
});

test("something that cannot be written out is just used as it is", () => {
  const loop = {};
  loop.self = loop;
  assert.equal(steadyAnswer("steady:loop", loop), loop);
  assert.equal(steadyAnswer("steady:loop", loop), loop);
  assert.equal(steadyAnswer("steady:nothing", undefined), undefined);
});

test("the answers are kept for a few questions only, so a card never piles them up", () => {
  const firsts = [];
  for (let i = 0; i < 40; i += 1) {
    const answer = { i };
    firsts.push(answer);
    steadyAnswer(`steady:many:${i}`, answer);
  }
  const again = { i: 0 };
  assert.equal(steadyAnswer("steady:many:0", again), again); // the oldest was forgotten
  const recent = { i: 39 };
  assert.equal(steadyAnswer("steady:many:39", recent), firsts[39]); // the newest is still known
});

const snapshot = (fields) => ({ data: undefined, error: undefined, loading: false, stale: false, updatedAt: undefined, ...fields });

test("a card is drawn again when the answer is another one", () => {
  const data = { n: 1 };
  assert.equal(drawnDifferently(snapshot({ data: { n: 1 } }), snapshot({ data })), true);
  assert.equal(drawnDifferently(snapshot({ data }), undefined), true);
  assert.equal(drawnDifferently(snapshot({ data: undefined }), snapshot({ data })), true);
});

test("a card is not drawn again for the steps of an ask, which show nothing", () => {
  const data = { n: 1 };
  assert.equal(drawnDifferently(snapshot({ data, loading: true }), snapshot({ data, loading: false })), false);
  assert.equal(drawnDifferently(snapshot({ data, updatedAt: 2000 }), snapshot({ data, updatedAt: 1000 })), false);
  assert.equal(drawnDifferently(snapshot({ data, stale: true }), snapshot({ data })), false);
  assert.equal(drawnDifferently(snapshot({ loading: true }), undefined), false); // still nothing to show but the placeholder
});

test("a card is drawn again when asking starts or stops failing, but not for one failure after another", () => {
  const data = { n: 1 };
  assert.equal(drawnDifferently(snapshot({ data, error: new Error("down") }), snapshot({ data })), true);
  assert.equal(drawnDifferently(snapshot({ data }), snapshot({ data, error: new Error("down") })), true);
  assert.equal(drawnDifferently(snapshot({ data, error: new Error("still down") }), snapshot({ data, error: new Error("down") })), false);
});
