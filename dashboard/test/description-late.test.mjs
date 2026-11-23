import test from "node:test";
import assert from "node:assert/strict";
import { aboutState, speciesFacts, withLateDescription, withoutPending } from "../src/facts.ts";

const wikipedia = { name: "Wikipedia", url: "https://en.wikipedia.org/wiki/Carolina_wren", licence: "CC BY-SA 4.0", licenceUrl: "https://creativecommons.org/licenses/by-sa/4.0/" };
const opened = () => speciesFacts({ perDay: [1, 2], scientific: null, description: null, descriptionSource: null, descriptionPending: true });

test("a sheet answer that says the words are still coming is marked pending", () => {
  const facts = opened();
  assert.equal(facts.descriptionPending, true);
  assert.equal(facts.description, null);
  assert.deepEqual(facts.perDay, [1, 2]);
});

test("pending is only ever true for a plain true and only while there is no description", () => {
  for (const odd of [false, "true", 1, null, undefined, {}]) assert.equal(speciesFacts({ descriptionPending: odd }).descriptionPending, false, String(odd));
  assert.equal(speciesFacts({ description: "The Carolina wren is a common wren of the south.", descriptionPending: true }).descriptionPending, false);
  assert.equal(speciesFacts(null).descriptionPending, false);
  assert.equal(speciesFacts({}).descriptionPending, false);
});

test("the About block shows text, a loading state, or nothing", () => {
  assert.equal(aboutState(null), "none");
  assert.equal(aboutState(speciesFacts({})), "none");
  assert.equal(aboutState(opened()), "loading");
  assert.equal(aboutState(speciesFacts({ description: "The Carolina wren is a common wren of the south." })), "text");
  assert.equal(aboutState({ description: "Words", descriptionPending: true }), "text", "words that are there are never hidden behind a loading state");
});

test("the late answer fills in the words and the credit and ends the waiting", () => {
  const facts = withLateDescription(opened(), { species: "Carolina Wren", scientific: " Thryothorus ludovicianus ", description: "The Carolina wren is a common wren.\n It lives in the south.", descriptionSource: wikipedia });
  assert.equal(facts.description, "The Carolina wren is a common wren. It lives in the south.");
  assert.deepEqual(facts.credit, wikipedia);
  assert.equal(facts.scientific, "Thryothorus ludovicianus");
  assert.equal(facts.descriptionPending, false);
  assert.deepEqual(facts.perDay, [1, 2], "the rest of the sheet is as it was");
  assert.equal(aboutState(facts), "text");
});

test("the late answer never replaces a scientific name the sheet already had", () => {
  const known = { ...opened(), scientific: "Cardinalis cardinalis" };
  assert.equal(withLateDescription(known, { scientific: "Something else", description: null }).scientific, "Cardinalis cardinalis");
});

test("a late answer with no description, or any odd answer, quietly ends the waiting", () => {
  for (const nothing of [{ species: "Unicorn", scientific: null, description: null, descriptionSource: null }, null, undefined, 7, "text", [], { description: 5 }]) {
    const facts = withLateDescription(opened(), nothing);
    assert.equal(facts.descriptionPending, false, JSON.stringify(nothing));
    assert.equal(facts.description, null);
    assert.equal(aboutState(facts), "none");
  }
});

test("giving up on the late answer ends the waiting and keeps everything else", () => {
  const facts = opened();
  const done = withoutPending(facts);
  assert.equal(done.descriptionPending, false);
  assert.equal(aboutState(done), "none");
  assert.deepEqual(done.perDay, facts.perDay);
  const settled = speciesFacts({});
  assert.equal(withoutPending(settled), settled, "nothing to change, nothing copied");
});
