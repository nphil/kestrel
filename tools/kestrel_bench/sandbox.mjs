// A small Kestrel plugin of its own, with nothing real in it. It is built from the plugin's real, Scrypted-free parts: the same store (a temp SQLite file),
// the same heard-call ingest, the same BirdNET-Go message reader, the same sighting-and-call linker, the same detection-box recorder. What the bench
// sends in goes through exactly the code a live message or camera event would; only the senders are fake. It never talks to Scrypted, MQTT, Home Assistant
// or the network, and its folder is deleted when it is closed.
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HeardIngest, SECOND_OPINION_SETTLE_MS, heardCallOf, readBirdnetMessage } from "../../scrypted-plugin/src/heard.ts";
import { linkSeenAndHeard } from "../../scrypted-plugin/src/link.ts";
import { commonnessFor } from "../../scrypted-plugin/src/seasonal.ts";
import { SEASONAL_PRIOR } from "../../scrypted-plugin/src/seasonal-prior.ts";
import { KestrelStore } from "../../scrypted-plugin/src/store.ts";
import { GENUS_CLASS, SPECIES_CLASS } from "../../scrypted-plugin/src/taxonomy.ts";
import { TrackRecorder, detectionOffsetMs, normalizeBoxes, visitPayload } from "../../scrypted-plugin/src/track.ts";
import { OCCURRENCE, birdnetMessage, walkTrack } from "./shapes.mjs";
import { findSpecies, heardName, loadSpecies, seenName } from "./species.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, "../../dashboard/dev/fixtures");

// The same three cameras the dashboard test page shows, with the clip picture that fits each one's shape.
export const CAMERAS = [
  { id: "88", name: "Backyard", ratio: 16 / 9, clip: "clip.mp4" },
  { id: "103", name: "Back Door", ratio: 4 / 3, clip: "clip-4x3.mp4" },
  { id: "104", name: "Front Door", ratio: 3 / 4, clip: "clip-3x4.mp4" },
];

const COOLDOWN_MS = 10 * 60_000;
const USUAL_WINDOW_MS = 30 * 24 * 60 * 60_000;
const USUAL_LIMIT = 3;
// The walk starts this long ago, so the clip is already "ready" and every box of it is in the past.
const WALK_AGO_MS = 4_000;

/** The same lookup main.ts gives readBirdnetMessage: a species' class, else its genus' class, else undefined (a bird). */
export const classOf = (scientific) => SPECIES_CLASS.get(scientific) ?? GENUS_CLASS.get(scientific.split(" ")[0]);

const pct = (value) => `${Math.round(value * 100)}%`;

export class Sandbox {
  /** `root`: where the temp folder goes ($CODY_DATA_SCRATCH, else the system temp folder). */
  constructor({ root = process.env.CODY_DATA_SCRATCH || tmpdir() } = {}) {
    mkdirSync(root, { recursive: true });
    // A bench that was killed outright (not stopped) cannot clean up after itself, so the next one clears folders a day old or more.
    for (const name of readdirSync(root)) {
      const old = name.startsWith("kestrel-bench-") && Date.now() - statSync(join(root, name)).mtimeMs > 24 * 60 * 60_000;
      if (old) rmSync(join(root, name), { recursive: true, force: true });
    }
    this.dir = mkdtempSync(join(root, "kestrel-bench-"));
    /** Where clip files live: the dashboard test page serves `<localDir>/<visit id>.mp4`. */
    this.localDir = join(this.dir, "local");
    mkdirSync(this.localDir, { recursive: true });
    this.species = loadSpecies(classOf);
    this.cameras = CAMERAS;
    this.closed = false;
    this.#open();
  }

  #open() {
    this.events = []; // what the plugin announced: { type: "visit_new" | "visit_updated" | "visit_deleted", id }
    this.created = []; // visit ids in the order they were made: what Drop takes back
    this.last = null; // the last thing sent, so Again can send it once more
    this.log = []; // one plain line per action, newest last
    this.sent = null; // the last message or event, as the plugin got it
    this.clock = 0;
    this.ids = 0;
    this.store = new KestrelStore(join(this.dir, "kestrel.sqlite"));
    this.recorder = new TrackRecorder(this.store);
    // main.ts starts by noting BirdNET v3.0 as running; that is what makes Perch a second opinion rather than the main voice.
    this.store.noteModelSeen("birdnet_v3", 3, Date.now());
    this.ingest = new HeardIngest({
      store: this.store,
      cooldownMs: () => COOLDOWN_MS,
      cameraName: (cameraId) => this.#camera(cameraId)?.name,
      isMuted: () => false,
      usualSuggestions: (cameraId, species) => this.#usual(cameraId, species),
      commonness: (scientific, at) => commonnessFor(SEASONAL_PRIOR, scientific, at),
      newId: () => this.#newId("heard"),
      created: (visit) => this.events.push({ type: "visit_new", id: visit.id }),
      updated: (visit) => this.events.push({ type: "visit_updated", id: visit.id }),
      link: (visit) => linkSeenAndHeard(this.store, visit, (other) => this.events.push({ type: "visit_updated", id: other.id })),
      failed: (error) => { throw error; },
    });
  }

  #newId(kind) {
    return `bench-${kind}-${++this.ids}-${Math.random().toString(16).slice(2, 6)}`;
  }

  #camera(idOrName) {
    const wanted = String(idOrName ?? CAMERAS[0].id).toLowerCase();
    return CAMERAS.find((camera) => camera.id === wanted || camera.name.toLowerCase() === wanted || camera.name.toLowerCase().replace(/\s+/g, "-") === wanted);
  }

  #usual(cameraId, species) {
    return this.store.usualSpeciesAtCamera(cameraId, species, Date.now() - USUAL_WINDOW_MS, USUAL_LIMIT).map((name) => ({ species: name, why: "usual" }));
  }

  /** Strictly later than the last time handed out, so two clicks in one second are still two calls and not one repeated message. */
  #now() {
    this.clock = Math.max(Date.now(), this.clock + 1000);
    return this.clock;
  }

  #entry(species) {
    const entry = typeof species === "string" ? findSpecies(this.species, species) : species;
    if (!entry) throw new Error(`No species matches "${species}". Try fewer letters.`);
    return entry;
  }

  #cameraOrThrow(camera) {
    const found = this.#camera(camera);
    if (!found) throw new Error(`No camera "${camera}". Cameras: ${CAMERAS.map((item) => `${item.name} (${item.id})`).join(", ")}.`);
    return found;
  }

  /**
   * Sends BirdNET-Go detections to the plugin, the way main.ts takes them off the broker: read the message, note the model, find the camera, drop
   * what the plugin drops, hand the rest to the heard ingest. Then it lets the 6 to 9 second wait for the other model run out at once.
   *   model "v3" | "perch" | "v24" | "none" | "disagree" (v3.0 says `species`, Perch says `other`)     style "nested" | "flat"
   *   occurrence "common" | "uncommon" | "rare" | "unknown" or a number 0-1     detectionId  a number (default: counts up) or 0
   */
  hear({ species, model = "v3", confidence = 0.9, occurrence = "common", camera = CAMERAS[0].id, style = "nested", other, detectionId }) {
    const entry = this.#entry(species);
    const cam = this.#cameraOrThrow(camera);
    const chance = typeof occurrence === "number" || occurrence === null ? occurrence : OCCURRENCE[occurrence];
    if (chance === undefined) throw new Error(`Unknown occurrence "${occurrence}" (common, uncommon, rare, unknown or a number 0-1)`);
    const sends = [{ entry, model: model === "disagree" ? "v3" : model, confidence }];
    if (model === "disagree") {
      const second = other ? this.#entry(other) : this.species.find((item) => item.group === entry.group && item.scientific !== entry.scientific && item.heardAs);
      sends.push({ entry: second, model: "perch", confidence: Math.max(0.5, confidence - 0.2), later: 1500 });
    }
    const from = this.events.length;
    const callsBefore = this.store.db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM heard_calls").get().id;
    const at = this.#now();
    const messages = [];
    let receivedAt = Date.now();
    let dropped = 0;
    for (const send of sends) {
      const id = detectionId ?? this.#heardDetectionId();
      const message = birdnetMessage({ commonName: heardName(send.entry), scientificName: send.entry.scientific, confidence: send.confidence, at: at + (send.later ?? 0), source: cam.name, model: send.model, style, occurrence: chance, detectionId: id });
      messages.push(message);
      receivedAt = Date.now() + (send.later ?? 0);
      if (!this.#receive(JSON.parse(JSON.stringify(message)), cam, receivedAt)) dropped++;
    }
    // The wait for the other model is skipped by asking the ingest for the time after it, twice: once for the call, once for a second opinion that waited for it.
    this.ingest.flush(receivedAt + SECOND_OPINION_SETTLE_MS + 1000);
    this.ingest.flush(receivedAt + 3 * SECOND_OPINION_SETTLE_MS);
    this.sent = messages.length === 1 ? messages[0] : messages;
    this.last = { action: "hear", args: { species: entry, model, confidence, occurrence, camera: cam.id, style, other, detectionId } };
    const changed = this.#changesSince(from, this.#visitsOfCallsAfter(callsBefore));
    return this.#report("heard", entry, changed, { dropped, messages: messages.length, text: this.#heardText(entry, model, confidence, changed, dropped) });
  }

  #heardDetectionId() {
    return 1000 + this.ids++;
  }

  // main.ts onBirdnetMessage, minus the broker and the settings it reads: the same steps in the same order.
  #receive(message, camera, receivedAt) {
    const reading = readBirdnetMessage(message, classOf, Date.now());
    if (!reading) return false;
    this.store.setSetting("birdnetLastHeardAt", String(reading.at));
    this.ingest.noteModel(reading.model.key, reading.model.rank, Date.now());
    if (reading.grp === "drop") {
      this.store.recordBirdnetIgnored();
      return false;
    }
    this.ingest.receive(heardCallOf(reading, reading.grp, camera.id, receivedAt));
    return true;
  }

  /**
   * An animal walks across a camera: Scrypted-shaped detection events go through the plugin's own box recorder, a seen visit is saved with a 3 second
   * clip, and the new sighting is linked to any call of the same bird on that camera in the last two minutes.
   *   labelScore  the classifier's confidence in its name (default 0.9; null leaves it out, as an NVR usually does)
   */
  see({ species, camera = CAMERAS[1].id, confidence = 0.9, labelScore = 0.9, second = true }) {
    const entry = this.#entry(species);
    const cam = this.#cameraOrThrow(camera);
    const name = seenName(entry);
    const from = this.events.length;
    const firstSeenAt = Date.now() - WALK_AGO_MS;
    const offsetMs = detectionOffsetMs(cam.id, "events");
    // A detection at time t is in the video at t + offset - clipStartAt, so the first one lands on the clip's first frame and the walk's 2.75 s fits the 3 s clip.
    const clipStartAt = firstSeenAt + offsetMs;
    const track = walkTrack({ startAt: firstSeenAt, ratio: cam.ratio, label: name, labelScore: labelScore === null ? undefined : labelScore, second });
    // The camera's detector says "animal" for the first second, then the classifier names it: that second is when the visit would be created.
    for (const event of track) {
      this.recorder.observe(cam.id, { t: event.timestamp, boxes: normalizeBoxes(event.detections, event.inputDimensions) });
    }
    const id = this.#newId("seen");
    const grp = entry.group === "bird" || entry.group === "mammal" ? entry.group : "other";
    const file = join(this.localDir, `${id}.mp4`);
    copyFileSync(join(FIXTURES, cam.clip), file);
    const visit = {
      id, camera: { id: cam.id, name: cam.name }, kind: "seen", startedAt: firstSeenAt, species: name, grp, status: "auto", score: confidence,
      snapshot: null, crop: null, clip: { state: "pending", expectedReadyAt: Date.now() }, heard: null, audio: null,
      suggestions: this.#usual(cam.id, name), firstEver: !this.store.hasSpecies(name), muted: false, notify: true, labelScore: labelScore ?? null,
    };
    this.store.saveVisit(visit, { detectionLabel: "animal", snapshotFile: `${id}.jpg`, cropFile: `${id}.jpg` });
    this.recorder.attach(cam.id, id, firstSeenAt);
    this.store.setClip(id, "ready", file, { source: "events", startAt: clipStartAt });
    this.created.push(id);
    this.events.push({ type: "visit_new", id });
    const saved = this.store.getVisit(id);
    linkSeenAndHeard(this.store, saved, (other) => this.events.push({ type: "visit_updated", id: other.id }));
    this.sent = track[track.length >> 1];
    this.last = { action: "see", args: { species: entry, camera: cam.id, confidence, labelScore, second } };
    const frames = this.store.getTrack(id).frames.length;
    return this.#report("seen", entry, this.#changesSince(from), { frames, text: `Saw ${name} on ${cam.name}: a clip and ${frames} box frames${saved.firstEver ? ", first one ever" : ""}.` });
  }

  /** Sends the last thing once more, as a new moment: a repeated call of the same bird folds into the visit it already has (more evidence, maybe a higher tier); a new sighting is a new visit. */
  again() {
    if (!this.last) throw new Error("Nothing sent yet. Hear or see something first.");
    return this[this.last.action](this.last.args);
  }

  /** Takes back the newest visit: its row, its track and its calls. The plugin announces the removal the way it does for a delete. */
  drop() {
    const id = this.created.pop();
    if (!id) throw new Error("No visit to drop.");
    this.store.db.prepare("DELETE FROM heard_calls WHERE visit_id=?").run(id);
    this.store.deleteTrack(id);
    this.store.deleteVisitRow(id);
    rmSync(join(this.localDir, `${id}.mp4`), { force: true });
    this.events.push({ type: "visit_deleted", id });
    this.#note(`Dropped the newest visit (${id}).`);
    return { text: `Dropped the newest visit.`, changed: [{ type: "visit_deleted", id }] };
  }

  /** Forgets everything: a brand new empty plugin (species list, first-ever flags and the model memory too). */
  reset() {
    this.ingest.dispose?.();
    this.store.close();
    rmSync(join(this.dir, "kestrel.sqlite"), { force: true });
    rmSync(join(this.dir, "kestrel.sqlite-wal"), { force: true });
    rmSync(join(this.dir, "kestrel.sqlite-shm"), { force: true });
    rmSync(this.localDir, { recursive: true, force: true });
    mkdirSync(this.localDir, { recursive: true });
    this.#open();
    this.#note("Reset: everything is gone, as if the bench had just started.");
    return { text: "Everything is gone.", changed: [{ type: "reset" }] };
  }

  // The visits the calls just sent were attached to: a repeat of a bird the plugin already has changes that visit without the plugin announcing it.
  #visitsOfCallsAfter(callId) {
    return this.store.db.prepare("SELECT DISTINCT visit_id FROM heard_calls WHERE id>? AND visit_id IS NOT NULL").all(callId).map((row) => row.visit_id);
  }

  #changesSince(from, touched = []) {
    const seen = new Map();
    for (const id of touched) seen.set(id, "visit_updated");
    for (const event of this.events.slice(from)) seen.set(event.id, event.type === "visit_new" || seen.get(event.id) === "visit_new" ? "visit_new" : event.type);
    this.created.push(...[...seen].filter(([id, type]) => type === "visit_new" && !this.created.includes(id)).map(([id]) => id));
    return [...seen].map(([id, type]) => ({ type, id }));
  }

  #report(kind, entry, changed, extra) {
    this.#note(extra.text);
    return { kind, species: entry.scientific, changed, visits: changed.filter((item) => item.type !== "visit_deleted").map((item) => this.summary(item.id)).filter(Boolean), ...extra };
  }

  #note(text) {
    this.log.push({ at: Date.now(), text });
    if (this.log.length > 40) this.log.shift();
  }

  #heardText(entry, model, confidence, changed, dropped) {
    const name = heardName(entry);
    const how = `${model === "disagree" ? "BirdNET v3.0 and Perch (naming another bird)" : { v3: "BirdNET v3.0", perch: "Perch", v24: "BirdNET v2.4", none: "an unknown model" }[model] ?? model} at ${pct(confidence)}`;
    if (dropped && !changed.length) return `Heard ${name} (${how}): the plugin ignores this kind of call (insects), so nothing was made.`;
    const visit = changed.map((item) => this.summary(item.id)).find((item) => item && item.kind === "heard");
    if (!visit) return `Heard ${name} (${how}): it is still waiting to count. Send it again to see a repeat.`;
    const tier = { likely: "Likely", possible: "Possible", check: "Check" }[visit.tier] ?? "a visit";
    const note = [visit.firstEver ? "first one ever" : null, visit.repeats ? `${visit.repeats} repeat${visit.repeats === 1 ? "" : "s"}` : null, visit.review ? "needs a look" : null].filter(Boolean).join(", ");
    return `Heard ${visit.species} (${how}): ${tier}${note ? `, ${note}` : ""}.`;
  }

  /** The few things worth knowing about one visit, in plain terms (undefined when it is gone). */
  summary(id) {
    const visit = this.store.getVisit(id);
    if (!visit) return undefined;
    return {
      id, kind: visit.kind, species: visit.species, camera: visit.camera.name, tier: visit.tier ?? null, tierWhy: visit.tierWhy ?? [], firstEver: visit.firstEver,
      notify: visit.notify, review: !!visit.review, repeats: visit.repeats ?? 0, score: visit.score, suggestions: visit.suggestions.map((item) => item.species),
      frames: visit.kind === "seen" ? this.store.getTrack(id).frames.length : undefined,
    };
  }

  /** Everything the dashboard test page needs to show this plugin's wildlife: the answers of the plugin's `visits`, `species` and `review` routes. */
  exportBench() {
    const visits = this.store.listVisits({ limit: 200 }).items.map((visit) => visitPayload(visit, this.store));
    return {
      visits,
      review: this.store.listReview().items?.map((visit) => visitPayload(visit, this.store)) ?? [],
      species: this.store.speciesList(),
      log: this.log,
      sent: this.sent,
      cameras: CAMERAS.map(({ id, name }) => ({ id, name })),
    };
  }

  /** Deletes the temp folder and closes the store. Safe to call twice. */
  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.store.close(); } catch { /* already closed */ }
    rmSync(this.dir, { recursive: true, force: true });
  }
}
