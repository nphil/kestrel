// What the panel makes of the server's answer about a species' reference recordings (src/api.ts), and the words under a clip (src/vocab.ts).
// Node runs the TypeScript files as they are:  cd dashboard && npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { referenceSounds } from "../src/api.ts";
import { referenceCredit, withArticle } from "../src/vocab.ts";

const clip = (over = {}) => ({
  id: "xc-1", kind: "song", label: "Song", source: "xeno-canto", sourceName: "Xeno-canto", credit: "Jane Birder", licence: "CC BY-NC-SA 4.0", quality: "A", seconds: 14,
  page: "https://xeno-canto.org/1", url: "/api/kestrel/media/species_sound/xc-1?authSig=a", ...over,
});
const ready = (...clips) => ({ species: "Northern Cardinal", scientific: "Cardinalis cardinalis", state: "ready", clips });

test("an answer that cannot be read is 'unavailable' (try again), never a crash", () => {
  for (const value of [undefined, null, 7, "ready", [], {}, { state: "maybe", clips: [clip()] }, { state: "ready" }, { state: "ready", clips: "no" }]) {
    const sounds = referenceSounds(value);
    assert.equal(sounds.state, "unavailable", JSON.stringify(value));
    assert.deepEqual(sounds.clips, []);
  }
});

test("'ready' without one clip that can be played is 'unavailable', not 'none'", () => {
  for (const clips of [[], [null], ["x"], [clip({ id: "" })], [clip({ url: "" })], [clip({ url: "media/species_sound/x" })]]) {
    assert.equal(referenceSounds(ready(...clips)).state, "unavailable", JSON.stringify(clips));
  }
});

test("a clip that cannot be played is dropped and the others keep their order", () => {
  const sounds = referenceSounds(ready(clip({ id: "xc-1" }), clip({ id: "bad", url: "" }), clip({ id: "xc-2", label: "Call", kind: "call" })));
  assert.equal(sounds.state, "ready");
  assert.deepEqual(sounds.clips.map((item) => item.id), ["xc-1", "xc-2"]);
});

test("'none' and 'unavailable' carry no clips even when the server sent some", () => {
  assert.deepEqual(referenceSounds({ state: "none", clips: [clip()] }), { species: "", scientific: null, state: "none", clips: [] });
  assert.equal(referenceSounds({ state: "unavailable", clips: [clip()] }).clips.length, 0);
});

test("what the server wrote about a clip comes through as it is", () => {
  const sounds = referenceSounds(ready(clip()));
  assert.equal(sounds.species, "Northern Cardinal");
  assert.equal(sounds.scientific, "Cardinalis cardinalis");
  assert.deepEqual(sounds.clips[0], clip());
});

test("odd fields on a clip are tolerated", () => {
  const [odd] = referenceSounds(ready(clip({ kind: "weird", label: "", credit: 5, licence: null, quality: "", seconds: "12", page: "javascript:alert(1)" }))).clips;
  assert.equal(odd.kind, "other");
  assert.equal(odd.label, "Recording");
  assert.equal(odd.credit, "");
  assert.equal(odd.licence, "");
  assert.equal(odd.quality, null);
  assert.equal(odd.seconds, null);
  assert.equal(odd.page, "");
  assert.equal(referenceSounds(ready(clip({ seconds: -3 }))).clips[0].seconds, null);
});

test("a clip keeps the same link from one answer to the next, so the browser does not download it again", () => {
  const first = referenceSounds(ready(clip({ id: "xc-steady", url: "/api/kestrel/media/species_sound/xc-steady?authSig=first" }))).clips[0].url;
  const second = referenceSounds(ready(clip({ id: "xc-steady", url: "/api/kestrel/media/species_sound/xc-steady?authSig=second" }))).clips[0].url;
  assert.equal(first, "/api/kestrel/media/species_sound/xc-steady?authSig=first");
  assert.equal(second, first);
});

test("the line under a clip names only the parts it has", () => {
  const nbsp = "\u00a0";
  assert.equal(referenceCredit(clip()), `Song · Jane Birder · CC BY-NC-SA 4.0 · Quality${nbsp}A · 14${nbsp}s`);
  assert.equal(referenceCredit(clip({ credit: "", licence: "", quality: "B", seconds: null })), `Song · Quality${nbsp}B`);
  assert.equal(referenceCredit(clip({ credit: "", quality: null, seconds: null })), "Song · CC BY-NC-SA 4.0");
  assert.equal(referenceCredit(clip({ licence: "", quality: null, seconds: null })), "Song · Jane Birder");
  assert.equal(referenceCredit(clip({ credit: "", licence: "", quality: null, seconds: null })), "Song");
});

test("a long clip is told in minutes", () => {
  const nbsp = "\u00a0";
  assert.match(referenceCredit(clip({ seconds: 65 })), new RegExp(`1${nbsp}min 5${nbsp}s$`));
  assert.match(referenceCredit(clip({ seconds: 120 })), new RegExp(`2${nbsp}min$`));
  assert.match(referenceCredit(clip({ seconds: 0.4 })), new RegExp(`1${nbsp}s$`));
});

test("a species name gets the article a person would say", () => {
  assert.equal(withArticle("Northern Cardinal"), "a Northern Cardinal");
  assert.equal(withArticle("American Robin"), "an American Robin");
  assert.equal(withArticle("Eastern Screech-Owl"), "an Eastern Screech-Owl");
  assert.equal(withArticle("Eurasian Wren"), "a Eurasian Wren");
  assert.equal(withArticle("Upland Sandpiper"), "an Upland Sandpiper");
});
