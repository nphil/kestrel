// The words for "how sure, really" (src/vocab.ts): the tier of a heard visit, why it got that tier, and the number shown as "NN% sure".
// Node runs the TypeScript files as they are:  cd dashboard && npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { tierWhyLine, tierWord, visitConfidence } from "../src/vocab.ts";

const v3 = (species, score = 0.6) => ({ model: "birdnet_v3", label: "BirdNET v3.0", species, score, role: "named" });
const perch = (species, role, score = 0.7) => ({ model: "perch_v2", label: "Perch v2", species, score, role });
const visit = (over = {}) => ({ status: "auto", score: 0.62, ...over });

test("the tier shows as a word, and only while nobody has looked at the visit", () => {
  assert.equal(tierWord(visit({ tier: "likely" })), "Likely");
  assert.equal(tierWord(visit({ tier: "possible" })), "Possible");
  assert.equal(tierWord(visit({ tier: "check" })), "Check this one");
  for (const status of ["confirmed", "corrected", "learned", "not_animal", "unknown"]) assert.equal(tierWord(visit({ tier: "check", status })), "", status);
});

test("no tier, or one we do not know, is no word", () => {
  for (const tier of [undefined, null, "", "maybe", "constructor", 3]) assert.equal(tierWord(visit({ tier })), "", String(tier));
});

test("two models that disagree are named, each with its own bird", () => {
  const line = tierWhyLine(visit({ tier: "check", tierWhy: ["models_disagree"], models: [v3("Blue Jay"), perch("American Crow", "other")] }));
  assert.equal(line, "The two models disagree: v3.0 says Blue Jay, Perch says American Crow.");
});

test("a disagreement without the calls still says so, never 'undefined'", () => {
  for (const models of [undefined, [], [v3("Blue Jay")], [perch("American Crow", "other")], [{ role: "named" }, { role: "other" }]]) {
    assert.equal(tierWhyLine(visit({ tierWhy: ["models_disagree"], models })), "The two models disagree about this one.", JSON.stringify(models));
  }
});

test("only the second opinion heard it", () => {
  assert.equal(tierWhyLine(visit({ tierWhy: ["second_opinion_only"], models: [perch("Blue Jay", "named")] })), "Only Perch heard this one; v3.0 did not.");
  assert.equal(tierWhyLine(visit({ tierWhy: ["second_opinion_only"] })), "Only one of the two models heard this one.");
});

test("each simple reason has its own sentence", () => {
  assert.equal(tierWhyLine(visit({ tierWhy: ["strong"] })), "A clear call.");
  assert.equal(tierWhyLine(visit({ tierWhy: ["weak"], repeats: 0 })), "A faint call, heard once.");
  assert.equal(tierWhyLine(visit({ tierWhy: ["weak"] })), "A faint call, heard once.");
  assert.equal(tierWhyLine(visit({ tierWhy: ["rare_here"], repeats: 0 })), "An unusual bird for this time of year, heard only once.");
  assert.equal(tierWhyLine(visit({ tierWhy: ["new_here"] })), "A bird not heard here before.");
  assert.equal(tierWhyLine(visit({ tierWhy: ["repeated"], repeats: 3 })), "Heard 4 times within a few minutes.");
});

test("a faint call of a new bird is one sentence, in either order", () => {
  assert.equal(tierWhyLine(visit({ tierWhy: ["weak", "new_here"] })), "A faint call of a bird not heard here before.");
  assert.equal(tierWhyLine(visit({ tierWhy: ["new_here", "weak"] })), "A faint call of a bird not heard here before.");
});

test("repeats replace 'heard once'", () => {
  assert.equal(tierWhyLine(visit({ tierWhy: ["weak"], repeats: 2 })), "A faint call.");
  assert.equal(tierWhyLine(visit({ tierWhy: ["rare_here"], repeats: 1 })), "An unusual bird for this time of year.");
  assert.equal(tierWhyLine(visit({ tierWhy: ["weak", "repeated"], repeats: 2 })), "A faint call. Heard 3 times within a few minutes.");
});

test("at most two sentences, most important first", () => {
  const line = tierWhyLine(visit({ tierWhy: ["models_disagree", "weak", "rare_here"], models: [v3("Blue Jay"), perch("American Crow", "other")] }));
  assert.equal(line, "The two models disagree: v3.0 says Blue Jay, Perch says American Crow. A faint call, heard once.");
  assert.equal(tierWhyLine(visit({ tierWhy: ["strong", "repeated"], repeats: 3 })), "A clear call. Heard 4 times within a few minutes.");
});

test("other models are named by their own label", () => {
  const line = tierWhyLine(visit({ tierWhy: ["models_disagree"], models: [{ model: "birdnet_v24", label: "BirdNET v2.4", species: "Blue Jay", role: "named" }, { model: "newmodel", label: "Fancy 9", species: "Steller's Jay", role: "other" }] }));
  assert.equal(line, "The two models disagree: BirdNET 2.4 says Blue Jay, Fancy 9 says Steller's Jay.");
});

test("no reasons, odd reasons and odd data give an empty line", () => {
  for (const tierWhy of [undefined, null, [], "weak", [null], ["unheard_of"], ["repeated"]]) assert.equal(tierWhyLine(visit({ tierWhy })), "", JSON.stringify(tierWhy));
  assert.equal(tierWhyLine({}), "");
  assert.equal(tierWhyLine(visit({ tierWhy: ["models_disagree"], models: "no" })), "The two models disagree about this one.");
  assert.equal(tierWhyLine(visit({ tierWhy: ["repeated"], repeats: "3" })), "");
});

test("the reason is not shown once a person has decided", () => {
  for (const status of ["confirmed", "corrected", "learned", "not_animal", "unknown"]) assert.equal(tierWhyLine(visit({ status, tierWhy: ["strong"] })), "", status);
});

test("a camera visit shows the classifier's confidence, not the box score", () => {
  assert.equal(visitConfidence({ score: 0.84, labelScore: 0.99 }), 0.99);
  assert.equal(visitConfidence({ score: 0.84, labelScore: 1 }), 1);
});

test("a classifier confidence that makes no sense falls back to the visit's score", () => {
  for (const labelScore of [0, -0.2, 1.5, NaN, Infinity, null, undefined, "0.9"]) assert.equal(visitConfidence({ score: 0.84, labelScore }), 0.84, String(labelScore));
});

test("no usable number at all is undefined, never NaN", () => {
  for (const score of [undefined, null, NaN, Infinity, "0.8"]) assert.equal(visitConfidence({ score, labelScore: null }), undefined, String(score));
  assert.equal(visitConfidence({}), undefined);
  assert.equal(visitConfidence({ score: 0 }), 0);
});
