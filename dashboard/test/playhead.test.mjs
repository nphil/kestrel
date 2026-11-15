import test from "node:test";
import assert from "node:assert/strict";
import { audioPath, audioPaths, playedFraction, playheadAt } from "../src/playhead.ts";

const media = (src, currentTime = 0, duration = 10, ended = false) => ({ currentSrc: src, src, currentTime, duration, ended });

test("audioPath ignores the host, the signature and the query", () => {
  assert.equal(audioPath("/api/kestrel/media/audio/12?authSig=abc"), "/api/kestrel/media/audio/12");
  assert.equal(audioPath("https://ha.example.com/api/kestrel/media/audio/12?authSig=other&x=1"), "/api/kestrel/media/audio/12");
  assert.equal(audioPath(""), "");
  assert.equal(audioPath(null), "");
  assert.equal(audioPath(undefined), "");
});

test("audioPaths keeps each path once and drops empty ones", () => {
  assert.deepEqual(audioPaths("/a?authSig=1", "/a?authSig=2", null, "/b"), ["/a", "/b"]);
  assert.deepEqual(audioPaths(), []);
});

test("playedFraction is 0 to 1 and 0 for a length it does not know", () => {
  assert.equal(playedFraction(2.5, 10), 0.25);
  assert.equal(playedFraction(12, 10), 1);
  assert.equal(playedFraction(-1, 10), 0);
  assert.equal(playedFraction(3, Number.NaN), 0);
  assert.equal(playedFraction(3, Number.POSITIVE_INFINITY), 0);
  assert.equal(playedFraction(3, 0), 0);
});

const paths = audioPaths("/api/kestrel/media/audio/12?authSig=a", "/api/kestrel/media/audio/12-original?authSig=a");

test("the playing recording is followed, by its own address or its fallback", () => {
  const playing = media("/api/kestrel/media/audio/12?authSig=zzz", 4, 8);
  assert.deepEqual(playheadAt(null, playing, paths), { audio: playing, fraction: 0.5 });
  const original = media("https://ha/api/kestrel/media/audio/12-original?authSig=q", 2, 8);
  assert.equal(playheadAt(null, original, paths).fraction, 0.25);
});

test("another recording playing sends the playhead back to the start", () => {
  const mine = media("/api/kestrel/media/audio/12?authSig=a", 4, 8);
  const other = media("/api/kestrel/media/audio/99?authSig=a", 1, 8);
  assert.deepEqual(playheadAt(mine, other, paths), { audio: null, fraction: 0 });
  assert.deepEqual(playheadAt(null, other, paths), { audio: null, fraction: 0 });
});

test("a paused recording keeps its place until it ends or changes", () => {
  const mine = media("/api/kestrel/media/audio/12?authSig=a", 4, 8);
  assert.deepEqual(playheadAt(mine, null, paths), { audio: mine, fraction: 0.5 });
  mine.currentTime = 6;
  assert.equal(playheadAt(mine, null, paths).fraction, 0.75, "moving the scrubber while paused moves the playhead");
  mine.ended = true;
  assert.deepEqual(playheadAt(mine, null, paths), { audio: null, fraction: 0 });
  const replaced = media("/api/kestrel/media/audio/77?authSig=a", 4, 8);
  assert.deepEqual(playheadAt(replaced, null, paths), { audio: null, fraction: 0 });
  const cleared = media("", 0, Number.NaN);
  assert.deepEqual(playheadAt(cleared, null, paths), { audio: null, fraction: 0 });
});

test("nothing playing and nothing followed is quiet", () => {
  assert.deepEqual(playheadAt(null, null, paths), { audio: null, fraction: 0 });
  assert.deepEqual(playheadAt(null, null, []), { audio: null, fraction: 0 });
});

test("an element that has not started loading yet is matched by its address", () => {
  const loading = { src: "/api/kestrel/media/audio/12?authSig=a", currentSrc: "", currentTime: 0, duration: Number.NaN, ended: false };
  assert.deepEqual(playheadAt(null, loading, paths), { audio: loading, fraction: 0 });
});
