// The sandbox plugin end to end: what the bench sends goes through the plugin's real heard ingest, linker, track recorder and store.
// Run: node --experimental-strip-types --test tools/kestrel_bench/test/*.test.mjs
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Sandbox } from "../sandbox.mjs";
import { benchRoutes, benchState } from "../server.mjs";

async function withSandbox(run) {
  const sandbox = new Sandbox();
  try { await run(sandbox); } finally { sandbox.close(); }
}

const heardVisits = (sandbox) => sandbox.store.listVisits({ kind: "heard", limit: 50 }).items;

test("a confident BirdNET v3.0 call becomes one Likely visit, the first of its species, that notifies", () => withSandbox((sandbox) => {
  const result = sandbox.hear({ species: "pileated woodpecker", model: "v3", confidence: 0.9 });
  const [visit] = heardVisits(sandbox);
  assert.equal(heardVisits(sandbox).length, 1);
  assert.equal(visit.species, "Pileated Woodpecker");
  assert.equal(visit.camera.name, "Backyard");
  assert.deepEqual([visit.tier, visit.tierWhy, visit.firstEver, visit.notify, visit.review], ["likely", ["strong"], true, true, false]);
  assert.deepEqual(visit.models.map((model) => model.model), ["birdnet_v3"]);
  assert.deepEqual(result.changed, [{ type: "visit_new", id: visit.id }]);
  assert.match(result.text, /Likely, first one ever/);
  assert.equal(visit.audio.birdnetClip.endsWith(".opus"), true);
}));

test("the same bird again folds into its visit as a repeat, and the bench says which visit changed", () => withSandbox((sandbox) => {
  sandbox.hear({ species: "northern cardinal", confidence: 0.9 });
  const again = sandbox.again();
  assert.equal(heardVisits(sandbox).length, 1, "no second visit inside the cooldown");
  assert.equal(heardVisits(sandbox)[0].repeats, 1);
  assert.equal(again.changed[0].type, "visit_updated");
  assert.match(again.text, /1 repeat/);
}));

test("v3.0 and Perch naming different birds make one visit named by v3.0, flagged for a look, with Perch's bird as a suggestion", () => withSandbox((sandbox) => {
  const result = sandbox.hear({ species: "blue jay", model: "disagree", confidence: 0.85, other: "american crow" });
  const visits = heardVisits(sandbox);
  assert.equal(visits.length, 1);
  const [visit] = visits;
  assert.equal(visit.species, "Blue Jay");
  assert.equal(visit.tier, "check");
  assert.equal(visit.review, true);
  assert.ok(visit.suggestions.some((item) => item.species === "American Crow" && item.why === "model"));
  assert.deepEqual(visit.models.map((model) => model.model).sort(), ["birdnet_v3", "perch_v2"]);
  assert.equal(sandbox.store.listReview().length, 1, "it is on the review list");
  assert.match(result.text, /Check/);
}));

test("a confident call BirdNET-Go tags unlikely is a Check visit that says why and waits on the review list; a later call that is not tagged clears it", () => withSandbox((sandbox) => {
  const result = sandbox.hear({ species: "northern cardinal", model: "v3", confidence: 0.95, unlikely: true });
  const [visit] = heardVisits(sandbox);
  assert.deepEqual([visit.tier, visit.tierWhy, visit.review, visit.notify, visit.firstEver, visit.unlikely], ["check", ["birdnet_unlikely"], true, false, false, true]);
  assert.equal(sandbox.store.listReview().length, 1, "it is on the review list");
  assert.match(result.text, /Check/);
  assert.match(result.text, /tagged unlikely by BirdNET-Go/);
  assert.equal(result.visits[0].unlikely, true, "the bench's own summary shows the tag");
  sandbox.again();
  assert.equal(heardVisits(sandbox)[0].unlikely, true, "the same call again keeps the tag, and the visit its place in the queue");
  assert.equal(heardVisits(sandbox)[0].tier, "check");
  sandbox.hear({ species: "northern cardinal", model: "v3", confidence: 0.95 });
  const [after] = heardVisits(sandbox);
  assert.equal(heardVisits(sandbox).length, 1, "still one visit");
  assert.deepEqual([after.tier, after.review, after.unlikely], ["likely", false, false]);
}));

test("Perch alone for a species Kestrel has never had is only a Check; a rare bird at one call is not Likely", () => withSandbox((sandbox) => {
  sandbox.hear({ species: "summer tanager", model: "perch", confidence: 0.9 });
  assert.equal(heardVisits(sandbox)[0].tier, "check");
  sandbox.hear({ species: "great horned owl", model: "v3", confidence: 0.95, occurrence: "rare", camera: "103" });
  const owl = heardVisits(sandbox).find((visit) => visit.species === "Great Horned Owl");
  assert.notEqual(owl.tier, "likely");
  assert.ok(owl.occurrence < 0.1);
}));

test("an insect call is dropped the way the plugin drops it: no visit, and nothing announced", () => withSandbox((sandbox) => {
  const result = sandbox.hear({ species: "western honey bee", model: "perch", confidence: 0.9 });
  assert.equal(sandbox.store.listVisits({ limit: 50 }).items.length, 0);
  assert.deepEqual(result.changed, []);
  assert.deepEqual(sandbox.events, []);
  assert.match(result.text, /ignores/);
}));

test("a walk makes a seen visit with a ready clip and twelve box frames, exported with the offsets the dashboard draws them by", () => withSandbox((sandbox) => {
  const result = sandbox.see({ species: "coyote", camera: "103", confidence: 0.9 });
  const { visits } = sandbox.exportBench();
  assert.equal(visits.length, 1);
  const [visit] = visits;
  assert.equal(visit.kind, "seen");
  assert.equal(visit.species, "Coyote");
  assert.equal(visit.camera.name, "Back Door");
  assert.equal(visit.clip.state, "ready");
  assert.ok(existsSync(join(sandbox.localDir, `${visit.id}.mp4`)), "the clip sits where the test page looks for it");
  assert.equal(visit.detections.frames.length, 12);
  assert.equal(visit.detections.offsetMs, 330);
  assert.equal(visit.detections.clipStartAt, visit.startedAt + 330);
  const first = visit.detections.frames[0];
  const videoTime = (frame) => frame.t + visit.detections.offsetMs - visit.detections.clipStartAt; // where the dashboard puts a frame in the video
  assert.equal(videoTime(first), 0, "the first box is on the clip's first frame");
  assert.equal(videoTime(visit.detections.frames[11]), 2750, "and the last is inside its 3 seconds");
  assert.equal(first.boxes[0].label, undefined);
  assert.equal(visit.detections.frames[6].boxes[0].label, "Coyote");
  assert.deepEqual(result.changed, [{ type: "visit_new", id: visit.id }]);
}));

test("a call and a sighting of the same animal on one camera are linked to each other", () => withSandbox((sandbox) => {
  sandbox.hear({ species: "coyote", confidence: 0.9, camera: "88" });
  const [heard] = heardVisits(sandbox);
  const result = sandbox.see({ species: "coyote", camera: "88" });
  const seen = sandbox.store.getVisit(result.changed[0].id);
  assert.equal(seen.heard.visitId, heard.id);
  assert.ok(seen.suggestions.some((item) => item.why === "heard"));
  assert.ok(result.changed.some((item) => item.type === "visit_updated" && item.id === heard.id), "the call's visit was touched too");
}));

test("drop takes back the newest visit, its call and its track, and a new call after that is a first again", () => withSandbox((sandbox) => {
  sandbox.hear({ species: "pileated woodpecker" });
  const seen = sandbox.see({ species: "coyote", camera: "103" });
  const seenId = seen.changed[0].id;
  const dropped = sandbox.drop();
  assert.deepEqual(dropped.changed, [{ type: "visit_deleted", id: seenId }]);
  assert.equal(sandbox.store.getVisit(seenId), undefined);
  assert.equal(sandbox.store.getTrack(seenId).frames.length, 0);
  assert.equal(existsSync(join(sandbox.localDir, `${seenId}.mp4`)), false);
  sandbox.drop();
  assert.equal(sandbox.store.listVisits({ limit: 50 }).items.length, 0);
  assert.equal(sandbox.store.db.prepare("SELECT COUNT(*) AS n FROM heard_calls").get().n, 0);
  sandbox.hear({ species: "pileated woodpecker" });
  assert.equal(heardVisits(sandbox)[0].firstEver, true);
  assert.throws(() => { sandbox.drop(); sandbox.drop(); }, /No visit to drop/);
}));

test("reset forgets everything, even which species were seen and which model was running", () => withSandbox((sandbox) => {
  sandbox.hear({ species: "pileated woodpecker" });
  sandbox.see({ species: "coyote", camera: "103" });
  assert.ok(sandbox.exportBench().species.length >= 2);
  const result = sandbox.reset();
  assert.deepEqual(result.changed, [{ type: "reset" }]);
  const exported = sandbox.exportBench();
  assert.deepEqual([exported.visits.length, exported.species.length, exported.log.length], [0, 0, 1]);
  sandbox.hear({ species: "pileated woodpecker" });
  assert.equal(heardVisits(sandbox)[0].firstEver, true);
  assert.throws(() => sandbox.again.call({ last: null }), /Nothing sent yet/);
}));

test("bad input is an error a person can read, not a crash", () => withSandbox((sandbox) => {
  assert.throws(() => sandbox.hear({ species: "zzzzzz" }), /No species matches "zzzzzz"/);
  assert.throws(() => sandbox.hear({ species: "coyote", camera: "kitchen" }), /No camera "kitchen"/);
  assert.throws(() => sandbox.hear({ species: "coyote", occurrence: "sometimes" }), /Unknown occurrence/);
  assert.throws(() => sandbox.hear({ species: "coyote", model: "gpt" }), /Unknown model/);
}));

test("the HTTP side: state, search, actions, the harness feed, and a POST that is not JSON is refused", () => withSandbox(async (sandbox) => {
  const routes = benchRoutes(sandbox, () => "<html></html>");
  const call = (method, path, { type = "application/json", body } = {}) => new Promise((resolve) => {
    const request = Object.assign(new EventEmitter(), { method, headers: { "content-type": type } });
    const response = { writeHead(status) { this.status = status; return this; }, end(text) { resolve({ status: this.status, body: text }); } };
    const handled = routes(request, response, new URL(path, "http://x"));
    if (handled && body !== undefined) queueMicrotask(() => { request.emit("data", Buffer.from(JSON.stringify(body))); request.emit("end"); });
    else if (handled && method === "POST") queueMicrotask(() => request.emit("end"));
    if (!handled) resolve({ status: "unhandled" });
  });
  assert.equal((await call("GET", "/somewhere-else")).status, "unhandled");
  assert.equal((await call("POST", "/bench/api/hear", { type: "text/plain" })).status, 415);
  const hear = await call("POST", "/bench/api/hear", { body: { species: "cardinal" } });
  assert.equal(hear.status, 200);
  assert.equal(JSON.parse(hear.body).state.visitCount, 1);
  const bad = await call("POST", "/bench/api/hear", { body: { species: "zzzzzz" } });
  assert.equal(bad.status, 400);
  assert.match(JSON.parse(bad.body).error, /No species/);
  const search = JSON.parse((await call("GET", "/bench/api/search?q=coyo")).body);
  assert.equal(search.results[0].scientific, "Canis latrans");
  const feed = JSON.parse((await call("GET", "/dev/fixtures/local/bench.json")).body);
  assert.equal(feed.visits.length, 1);
  assert.equal(feed.species[0].species, "Northern Cardinal");
  assert.equal(benchState(sandbox).canAgain, true);
  const tagged = await call("POST", "/bench/api/hear", { body: { species: "blue jay", unlikely: true } });
  assert.equal(tagged.status, 200);
  const taggedVisit = JSON.parse((await call("GET", "/dev/fixtures/local/bench.json")).body).visits.find((visit) => visit.species === "Blue Jay");
  assert.deepEqual([taggedVisit.tier, taggedVisit.tierWhy, taggedVisit.unlikely], ["check", ["birdnet_unlikely"], true], "the HTTP side passes the tag on");
}));

test("closing deletes the temp folder, and closing twice is fine", () => {
  const sandbox = new Sandbox();
  sandbox.hear({ species: "pileated woodpecker" });
  assert.ok(existsSync(sandbox.dir));
  sandbox.close();
  assert.equal(existsSync(sandbox.dir), false);
  sandbox.close();
});
