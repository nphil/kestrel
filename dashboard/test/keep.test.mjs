// "Keep recording" (src/keep.ts): what the server's answer is read as, and the line under the control.
// Node runs the TypeScript files as they are:  cd dashboard && npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { keepCaption, keptRecording } from "../src/keep.ts";

test("a plain answer is read as it is", () => {
  assert.deepEqual(keptRecording({ keepable: true, kept: true, canChange: true }), { keepable: true, kept: true, canChange: true });
  assert.deepEqual(keptRecording({ keepable: true, kept: false, canChange: false }), { keepable: true, kept: false, canChange: false });
});

test("only a real true counts: a strange answer never shows a recording as kept or changeable", () => {
  for (const value of [undefined, null, "", "yes", 1, [], {}, { kept: "true", keepable: "true", canChange: 1 }]) {
    assert.deepEqual(keptRecording(value), { keepable: false, kept: false, canChange: false }, JSON.stringify(value));
  }
});

test("a recording that cannot be kept is never shown as kept", () => {
  assert.deepEqual(keptRecording({ keepable: false, kept: true, canChange: true }), { keepable: false, kept: false, canChange: true });
});

test("the line under the control says what keeping does, in plain words", () => {
  assert.equal(keepCaption({ keepable: true, kept: false, canChange: true }, false), "Kept recordings are never deleted automatically");
  assert.equal(keepCaption({ keepable: true, kept: true, canChange: true }, false), "Kept recordings are never deleted automatically");
});

test("somebody who cannot change it is told who can, and a failure says so", () => {
  assert.match(keepCaption({ keepable: true, kept: true, canChange: false }, false), /Only an administrator can keep one/);
  assert.equal(keepCaption({ keepable: true, kept: false, canChange: true }, true), "Couldn't change this recording. Try again.");
});
