import "../src/main.ts";
import { mountHa, themeFromQuery, type DockedSidebar, type MiniHa } from "./ha/mount.ts";
import { PANEL_PREFIX, haNavigate } from "./ha/panel.ts";
import { THEME_NAMES } from "./ha/theme.ts";
import type { Camera, Health, ModelCall, RangeFilter, ReferenceClip, ReferenceSounds, Settings, Species, Visit } from "../src/types.ts";

const now = Date.now();
/** Unsigned media path, the shape of the integration's route (`/api/kestrel/media/<kind>/<id>`). The fake server signs it per response (see `signed`). */
const media = (kind: string, id: string | number): string => `/api/kestrel/media/${kind}/${encodeURIComponent(String(id))}`;
const slug = (name: string): string => name.toLowerCase().replace(/[^a-z]+/g, "-");
/** A species with no photo of its own: the reference photo and the link to who took it (`kestrel/species` carries both, or neither). */
const reference = (name: string): Pick<Species, "referenceImage" | "referenceImageInfoUrl"> => ({ referenceImage: media("reference", slug(name)), referenceImageInfoUrl: media("reference-info", slug(name)) });
const cameras: Camera[] = [
  { id: 88, name: "Backyard", nvrCardId: 88, online: true, health: "ok", drops1h: 0, wildlife: true, lastDetection: { species: "Northern Cardinal", at: now - 3_000, visitId: "fixture-visit-1", kind: "seen", grp: "bird" } },
  { id: 103, name: "Back Door", nvrCardId: 103, online: true, health: "ok", drops1h: 1, wildlife: true, lastDetection: { species: "Blue Jay", at: now - 180_000, visitId: "fx-heard-blue-jay-0", kind: "heard", grp: "bird" } },
  { id: 104, name: "Front Door", nvrCardId: 104, online: true, health: "unstable", drops1h: 4, wildlife: true, lastDetection: { species: "Eastern Gray Squirrel", at: now - 30_000, visitId: "fx-seen-eastern-gray-squirrel-0", kind: "seen", grp: "mammal" } },
  { id: 105, name: "Plant Room", nvrCardId: 105, online: true, health: "ok", drops1h: 0, wildlife: false, lastDetection: { species: "House Mouse", at: now - 30 * 3_600_000, visitId: "fx-seen-house-mouse-0", kind: "seen", grp: "mammal" } },
  { id: 106, name: "Bird", nvrCardId: null, online: true, health: "ok", drops1h: 0, wildlife: true, picture: media("live", 106), lastDetection: null },
  { id: 108, name: "Tool Room", nvrCardId: null, online: true, health: "ok", drops1h: 0, wildlife: false, picture: media("live", 108), lastDetection: null },
  { id: 128, name: "Office", nvrCardId: null, online: true, health: "ok", drops1h: 0, wildlife: false, picture: media("live", 128), lastDetection: null },
  { id: 168, name: "Gym", nvrCardId: 168, online: true, health: "ok", drops1h: 0, wildlife: false, lastDetection: null },
  { id: 196, name: "Downstairs Door", nvrCardId: null, online: false, health: "offline", drops1h: 2, wildlife: false, picture: media("live", 196), lastDetection: null },
  { id: 240, name: "Plant Room Cat Feeder", nvrCardId: 240, online: true, health: "ok", drops1h: 0, wildlife: true, lastDetection: null },
];
const createVisit = (): Visit => ({
  id: "fixture-visit-1", camera: { id: 88, name: "Backyard" }, kind: "seen", startedAt: new Date(now - 18_000).toISOString(), species: "Northern Cardinal", grp: "bird", status: "auto", score: 0.91,
  snapshot: media("snapshot", "fixture-visit-1"), crop: media("crop", "fixture-visit-1"), clip: { state: "pending", expectedReadyAt: new Date(Date.now() + 10_000).toISOString() },
  heard: { visitId: "fixture-heard-1", species: "Northern Cardinal", hasAudio: true }, suggestions: [{ species: "Northern Cardinal", why: "model" }, { species: "House Finch", why: "usual" }], firstEver: true, muted: false,
});
let visit = createVisit();
let previousVisit: Visit | null = null;
let settings: Settings = { mutedSpecies: [], heardNotify: "new_only" };
let rangeFilter: RangeFilter = { threshold: 0.03, speciesCount: 150, latitude: 44.5, longitude: -76.5, updatedAt: "2026-10-03T06:00:00Z", rebuilding: false, canChange: true };
// Saved camera clips (`kestrel/clips/storage` and `kestrel/clips/delete`): 312 clips over about seven months, 1 in 17 from a visit marked "Not an animal" or "Can't tell".
// Harness settings: `admin=0` is a signed-in non-administrator, `clipfail=1` makes every clip request fail, `clipdelay=ms` slows a delete so its progress can be seen.
interface FakeClip { startedAt: number; bytes: number; notAnimal: boolean; unconfirmed: boolean }
let clips: FakeClip[] = Array.from({ length: 312 }, (_, index) => ({ startedAt: now - (index + 1) * 0.67 * 86_400_000, bytes: 3_000_000 + ((index * 37) % 31) * 100_000, notAnimal: index % 17 === 3, unconfirmed: index % 11 === 5 }));
const sumClips = (list: FakeClip[]): { count: number; bytes: number } => ({ count: list.length, bytes: list.reduce((total, clip) => total + clip.bytes, 0) });
const hours = Array.from({ length: 24 }, (_, hour) => hour >= 7 && hour <= 11 ? 3 : hour >= 17 && hour <= 20 ? 2 : 0);
const iso = (ms: number): string => new Date(ms).toISOString();
const species: Species[] = [
  { species: "Northern Cardinal", grp: "bird", seen: true, heard: true, first: iso(now - 2_000_000), last: iso(now - 18_000), count30d: 28, seenCount30d: 4, heardCount30d: 24, lastSeenAt: now - 18_000, lastHeardAt: now - 900_000, lastSeenCamera: "88", lastHeardCamera: "88", hasPhoto: true, photo_url: media("species", slug("Northern Cardinal")), cameras: { "88": 8, "104": 3, "103": 1 }, hours, newThisYear: true },
  { species: "Eastern Gray Squirrel", grp: "mammal", seen: true, heard: false, first: iso(now - 4_000_000), last: iso(now - 30_000), count30d: 5, seenCount30d: 5, heardCount30d: 0, lastSeenAt: now - 30_000, lastSeenCamera: "104", hasPhoto: true, photo_url: media("species", slug("Eastern Gray Squirrel")), cameras: { "104": 5, "88": 2 }, hours: hours.map((n, i) => i < 8 ? n : 0), newThisYear: false },
  { species: "Common Raccoon", grp: "mammal", seen: true, heard: true, first: iso(now - 9_000_000), last: iso(now - 86_000_000), count30d: 6, seenCount30d: 1, heardCount30d: 5, lastSeenAt: now - 86_000_000, lastHeardAt: now - 90_000_000, lastSeenCamera: "88", lastHeardCamera: "103", hasPhoto: false, ...reference("Common Raccoon"), cameras: { "88": 2, "103": 1 }, hours: hours.map((n, i) => i > 19 ? n + 2 : 0), newThisYear: false },
  { species: "Eastern Screech-Owl", grp: "bird", seen: false, heard: true, first: iso(now - 1_000_000), last: iso(now - 500_000), count30d: 5, seenCount30d: 0, heardCount30d: 5, lastHeardAt: now - 500_000, lastHeardCamera: "103", hasPhoto: false, cameras: {}, hours: hours.map((n, i) => i > 20 ? 1 : 0), newThisYear: true },
  { species: "Great Horned Owl", grp: "bird", seen: false, heard: true, first: iso(now - 1_200_000), last: iso(now - 600_000), count30d: 8, seenCount30d: 0, heardCount30d: 8, lastHeardAt: now - 600_000, lastHeardCamera: "88", hasPhoto: false, cameras: {}, hours: hours.map((n, i) => i > 19 ? 1 : 0), newThisYear: true },
  { species: "Blue Jay", grp: "bird", seen: false, heard: true, first: iso(now - 3_000_000), last: iso(now - 180_000), count30d: 12, seenCount30d: 0, heardCount30d: 12, lastHeardAt: now - 180_000, lastHeardCamera: "103", hasPhoto: false, ...reference("Blue Jay"), cameras: {}, hours, newThisYear: false },
  { species: "Spring Peeper", grp: "other", seen: false, heard: true, first: iso(now - 5_000_000), last: iso(now - 7_200_000), count30d: 3, seenCount30d: 0, heardCount30d: 3, lastHeardAt: now - 7_200_000, lastHeardCamera: "88", hasPhoto: false, cameras: {}, hours: hours.map((n, i) => i > 20 ? 2 : 0), newThisYear: false },
  { species: "House Mouse", grp: "mammal", seen: true, heard: false, first: iso(now - 40 * 3_600_000), last: iso(now - 30 * 3_600_000), count30d: 1, seenCount30d: 1, heardCount30d: 0, lastSeenAt: now - 30 * 3_600_000, lastSeenCamera: "105", hasPhoto: false, cameras: { "105": 1 }, hours: hours.map((n, i) => i === 2 ? 1 : 0), newThisYear: false },
];
/** Generated visits so the species sheet has something to page through. Newest first. */
function generated(): Visit[] {
  const out: Visit[] = [];
  for (const item of species) {
    const seen = item.seenCount30d ?? 0;
    const heardCount = item.heardCount30d ?? 0;
    for (let i = 0; i < seen; i += 1) {
      if (item.species === "Northern Cardinal" && i === 0) continue; // the mutable visit stands in for this one
      const at = Number(item.lastSeenAt) - i * 3_600_000;
      out.push({ id: `fx-seen-${slug(item.species)}-${i}`, camera: { id: Number(item.lastSeenCamera ?? 88), name: cameras.find((camera) => String(camera.id) === String(item.lastSeenCamera))?.name ?? "Backyard" }, kind: "seen", startedAt: at, species: item.species, grp: item.grp, status: "auto", score: 0.88, snapshot: media("snapshot", `fx-seen-${slug(item.species)}-${i}`), crop: media("crop", `fx-seen-${slug(item.species)}-${i}`), clip: item.species === "Common Raccoon" ? { state: "none" } : { state: "ready", url: media("clip", `fx-seen-${slug(item.species)}-${i}`) }, heard: null, suggestions: [], firstEver: false, muted: false });
    }
    for (let i = 0; i < heardCount; i += 1) {
      const at = Number(item.lastHeardAt) - i * 1_800_000;
      out.push({ id: `fx-heard-${slug(item.species)}-${i}`, camera: { id: Number(item.lastHeardCamera ?? 88), name: cameras.find((camera) => String(camera.id) === String(item.lastHeardCamera))?.name ?? "Backyard" }, kind: "heard", startedAt: at, species: item.species, grp: item.grp, status: "auto", score: 0.55 + ((i * 7) % 40) / 100, snapshot: null, crop: null, clip: { state: "none" }, heard: null, audio: i === 3 ? null : media("audio", `fx-heard-${slug(item.species)}-${i}`), ...(i % 3 === 0 ? { audioOriginal: media("audio-original", `fx-heard-${slug(item.species)}-${i}`), audioInfo: { state: "ready", segment: { start: 3.2, end: 8.1 }, cleaned: true, method: "gate" } } : i % 3 === 1 ? { audioOriginal: media("audio-original", `fx-heard-${slug(item.species)}-${i}`), audioInfo: { state: "ready", segment: { start: 1, end: 6.4 }, cleaned: false, method: "trim" } } : { audioInfo: { state: "pending" } }), suggestions: [], firstEver: false, muted: false });
    }
  }
  return out;
}

// Enough species to need "Show more species" (the panel shows 24 at first); names are plain bird names so the tiles read like real ones.
const MORE_SPECIES = ["American Robin", "House Finch", "Mourning Dove", "Dark-eyed Junco", "Carolina Wren", "Tufted Titmouse", "White-breasted Nuthatch", "Downy Woodpecker", "Red-bellied Woodpecker", "American Goldfinch", "Song Sparrow", "Chipping Sparrow", "Eastern Towhee", "Gray Catbird", "Northern Mockingbird", "Brown Thrasher", "Cedar Waxwing", "Ruby-throated Hummingbird", "Baltimore Oriole", "Indigo Bunting", "Red-winged Blackbird", "Common Grackle", "European Starling", "American Crow", "Barred Owl", "Cooper's Hawk", "Red-tailed Hawk", "Wild Turkey", "Eastern Chipmunk", "Virginia Opossum", "Striped Skunk", "White-tailed Deer", "Red Fox", "Eastern Cottontail", "Eastern Bluebird", "Pine Siskin", "Purple Finch", "Hairy Woodpecker", "Pileated Woodpecker", "Brown-headed Cowbird"];
MORE_SPECIES.forEach((name, index) => {
  const seenAt = now - (index + 2) * 5_400_000;
  species.push({ species: name, grp: /Squirrel|Chipmunk|Opossum|Skunk|Deer|Fox|Cottontail/.test(name) ? "mammal" : "bird", seen: true, heard: false, first: iso(seenAt - 3_600_000), last: iso(seenAt), count30d: 3, seenCount30d: 3, heardCount30d: 0, lastSeenAt: seenAt, lastSeenCamera: "88", hasPhoto: index % 2 === 0, ...(index % 2 === 0 ? { photo_url: media("species", slug(name)) } : reference(name)), cameras: { "88": 3 }, hours, newThisYear: false });
});
const generatedVisits = generated();
// ---- "how sure, really": heard visits with a tier, and a camera visit with the classifier's own confidence ----------------------------------------
const call = (model: string, label: string, speciesName: string, score: number | null, role: "named" | "agree" | "other"): ModelCall => ({ model, label, species: speciesName, score, role });
const heardTier = (id: string, speciesName: string, cameraId: number, minutesAgo: number, score: number, extra: Partial<Visit>): Visit => ({
  id, camera: { id: cameraId, name: cameras.find((camera) => camera.id === cameraId)?.name ?? "Back Door" }, kind: "heard", startedAt: now - minutesAgo * 60_000, species: speciesName, grp: "bird", status: "auto", score,
  snapshot: null, crop: null, clip: { state: "none" }, heard: null, audio: media("audio", id), suggestions: [], firstEver: false, muted: false, ...extra,
});
const tieredVisits: Visit[] = [
  heardTier("fx-tier-likely", "Blue Jay", 103, 1, 0.94, { tier: "likely", tierWhy: ["strong", "repeated"], repeats: 3, occurrence: 0.41, models: [call("birdnet_v3", "BirdNET v3.0", "Blue Jay", 0.94, "named"), call("perch_v2", "Perch v2", "Blue Jay", 0.88, "agree")] }),
  heardTier("fx-tier-possible", "Blue Jay", 103, 7, 0.46, { tier: "possible", tierWhy: ["weak"], repeats: 0, occurrence: 0.3, models: [call("birdnet_v3", "BirdNET v3.0", "Blue Jay", 0.46, "named")] }),
  heardTier("fx-tier-check", "Blue Jay", 103, 12, 0.62, { tier: "check", tierWhy: ["models_disagree"], repeats: 0, occurrence: 0.41, models: [call("birdnet_v3", "BirdNET v3.0", "Blue Jay", 0.62, "named"), call("perch_v2", "Perch v2", "American Crow", 0.71, "other")] }),
  heardTier("fx-tier-second", "Eastern Screech-Owl", 88, 25, 0.58, { tier: "check", tierWhy: ["second_opinion_only", "new_here"], repeats: 0, occurrence: 0.05, models: [call("perch_v2", "Perch v2", "Eastern Screech-Owl", 0.58, "named")] }),
  { ...createVisit(), id: "fx-seen-labelscore", camera: { id: 104, name: "Front Door" }, startedAt: now - 40 * 60_000, species: "Eastern Gray Squirrel", grp: "mammal", score: 0.84, labelScore: 0.99, heard: null, firstEver: false, clip: { state: "none" }, snapshot: media("snapshot", "fx-seen-labelscore"), crop: media("crop", "fx-seen-labelscore") },
  // "Could also be": what the audio service's second listen says (dev/smoke/fixture-alternatives.mjs). Hermit Thrush is in no species list, so these touch no other fixture.
  heardTier("fx-alts-thrush", "Hermit Thrush", 103, 3, 0.58, { audioInfo: { state: "ready", segment: { start: 3.2, end: 8.1 }, cleaned: false, method: "trim", alternatives: [
    { species: "Northern Cardinal", scientific: "Cardinalis cardinalis", score: 0.41, windowsHigh: 3, window: { start: 1, end: 6 } },
    { species: "House Finch", scientific: "Haemorhous mexicanus", score: 0.27, windowsHigh: 1, window: { start: 4.5, end: 9.5 } },
    { species: "Spring Peeper", scientific: "Pseudacris crucifer", score: 0.16, windowsHigh: 2, window: { start: 7, end: 12 } },
  ], announced: { species: "Hermit Thrush", scientific: "Catharus guttatus", score: 0.09, windowsHigh: 1, window: { start: 2, end: 7 }, rank: 4 } } }),
  heardTier("fx-alts-agree", "Hermit Thrush", 103, 4, 0.9, { audioInfo: { state: "ready", segment: { start: 3.2, end: 8.1 }, cleaned: false, method: "trim", alternatives: [] } }),
  heardTier("fx-alts-old", "Hermit Thrush", 103, 5, 0.7, { audioInfo: { state: "ready", segment: { start: 3.2, end: 8.1 }, cleaned: false, method: "trim" } }),
];
generatedVisits.push(...tieredVisits);
const startedMs = (item: Visit): number => typeof item.startedAt === "number" ? item.startedAt : Date.parse(item.startedAt);
const health: Health = { detector: { name: "EVA Wildlife", provider: "ONNX", avgMs: 38, checksToday: 124 }, gpu: { usedMiB: 3900, totalMiB: 23040, util: 22 }, cameras: [{ id: 88, checksToday: 80, emptyChecksToday: 11, visitsToday: 4 }, { id: 103, checksToday: 26, emptyChecksToday: 5, visitsToday: 2 }, { id: 104, checksToday: 18, emptyChecksToday: 2, visitsToday: 1 }], storage: { dbMB: 41.4, mediaMB: 98.2, budgetMB: 300 }, birdnet: { online: true, lastHeardAt: new Date(now - 11 * 60_000).toISOString() }, corrections: { total: 18, sinceRetrain: 4 } };

// ---- reference recordings: what `kestrel/species/reference` answers (Xeno-canto, or iNaturalist when there is no key) ------------------------------
// The panel never talks to those sites: every clip is a signed media link (`species_sound`), which dev/serve.mjs answers with dev/fixtures/call.mp3.
const xenoCanto = (number: number, kind: "song" | "call", credit: string, seconds: number): ReferenceClip => ({ id: `xc-${number}`, kind, label: kind === "song" ? "Song" : "Call", source: "xeno-canto", sourceName: "Xeno-canto", credit, licence: "CC BY-NC-SA 4.0", quality: "A", seconds, page: `https://xeno-canto.org/${number}`, url: media("species_sound", `xc-${number}`) });
const iNaturalist = (observation: number, label: string, credit: string, seconds: number): ReferenceClip => ({ id: `inat-${observation}`, kind: "other", label, source: "inaturalist", sourceName: "iNaturalist", credit, licence: "CC BY-NC", quality: null, seconds, page: `https://www.inaturalist.org/observations/${observation}`, url: media("species_sound", `inat-${observation}`) });
const REFERENCE_CLIPS: Record<string, ReferenceClip[]> = {
  "Northern Cardinal": [xenoCanto(694038, "song", "Jane Birder", 14), xenoCanto(412983, "call", "Sam Listener", 6)],
  "Carolina Wren": [xenoCanto(701122, "song", "Ruth Fieldnotes", 11), xenoCanto(512017, "call", "Omar Hale", 5)],
  "Great Horned Owl": [{ ...xenoCanto(655301, "song", "", 38), credit: "", licence: "", quality: "B", seconds: null }], // a sparse clip: no recordist, licence or length known
  "Spring Peeper": [iNaturalist(1944677, "Clip 1", "frogwatcher", 18), iNaturalist(2210054, "Clip 2", "pondside_notes", 24), iNaturalist(1180932, "Clip 3", "marsh_ears", 9)], // several iNaturalist clips are "Clip 1".."Clip 3" ...
  "Common Raccoon": [iNaturalist(3302188, "Recording", "backyard_nights", 12)], // ... a lone one is "Recording" (the server's labels)
};
const SCIENTIFIC: Record<string, string> = { "Northern Cardinal": "Cardinalis cardinalis", "Carolina Wren": "Thryothorus ludovicianus", "Great Horned Owl": "Bubo virginianus", "Spring Peeper": "Pseudacris crucifer", "Common Raccoon": "Procyon lotor", "House Mouse": "Mus musculus" };
/** Great Horned Owl is "unavailable" the first time it is asked (the server was busy) and answers after a retry. Species without clips (House Mouse) are a stable "none". */
let owlAsked = 0;
function referenceAnswer(name: string): ReferenceSounds {
  const scientific = SCIENTIFIC[name] ?? null;
  if (name === "Great Horned Owl" && ++owlAsked === 1) return { species: name, scientific, state: "unavailable", clips: [] };
  const clips = REFERENCE_CLIPS[name] ?? [];
  return { species: name, scientific, state: clips.length ? "ready" : "none", clips };
}

// ---- the fake server -------------------------------------------------------------------------------------------------
// Home Assistant signs every media link (`async_sign_path`: path + `?authSig=<token>`), and the secret is new after every restart.
// The harness stands for that with `?authSig=e<epoch>`: a payload built after `__ha.restart()` carries the NEW epoch, a payload fetched
// before keeps the OLD one, and a test's request interceptor answers 401 for an old epoch (see dev/smoke/lib/fixture.mjs).
// Harness settings come from the address on the FIRST load (`?theme= &toolbar=1 &sidebar= &kiosk=1 &safe=t,r,b,l &latency=ms &epoch=N`), are kept
// in sessionStorage for this tab, and are removed from the address, so the panel's own addresses stay exactly /kestrel/<view>[?s=|?v=] and a
// reload keeps the theme and the signing epoch (the server did not restart because the page did).
const SETTINGS_KEY = "kestrel-harness";
const SETTING_NAMES = ["theme", "epoch", "toolbar", "sidebar", "kiosk", "safe", "latency", "admin", "clipfail", "clipdelay", "clip"];
const settings0: Record<string, string> = (() => {
  try { return JSON.parse(window.sessionStorage.getItem(SETTINGS_KEY) ?? "{}") as Record<string, string>; } catch { return {}; }
})();
const incoming = new URLSearchParams(location.search);
for (const name of SETTING_NAMES) {
  const value = incoming.get(name);
  if (value !== null) settings0[name] = value;
  incoming.delete(name);
}
window.sessionStorage.setItem(SETTINGS_KEY, JSON.stringify(settings0));
const rest = incoming.toString();
history.replaceState(history.state, "", `${location.pathname}${rest ? `?${rest}` : ""}${location.hash}`);
const setting = (name: string): string | null => settings0[name] ?? null;
const remember = (name: string, value: string): void => { settings0[name] = value; window.sessionStorage.setItem(SETTINGS_KEY, JSON.stringify(settings0)); };
// `clip=ready`: the fixture visit already has its clip (otherwise it is still being saved until the toolbar's "Processing visit" runs).
if (setting("clip") === "ready") visit = { ...visit, clip: { state: "ready", url: media("clip", visit.id) } };

const MEDIA_PREFIX = "/api/kestrel/media/";
const LATENCY_MS = Number(setting("latency") ?? 40);
const delay = (ms: number): Promise<void> => new Promise((done) => window.setTimeout(done, ms));
let epoch = Number(setting("epoch") ?? 0) || 0;

function signed<T>(value: T): T {
  if (typeof value === "string") return (value.startsWith(MEDIA_PREFIX) ? `${value}?authSig=e${epoch}` : value) as T;
  if (Array.isArray(value)) return value.map((item) => signed(item)) as T;
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, signed(item)])) as T;
  return value;
}

function answer(message: Record<string, unknown>): unknown {
  const type = String(message.type ?? "");
  let result: unknown;
  if (type === "kestrel/cameras") result = cameras;
    else if (type === "kestrel/visits") {
      const wanted = typeof message.species === "string" ? message.species : null;
      const kind = message.kind === "seen" || message.kind === "heard" ? message.kind : null;
      const limit = Math.min(50, Math.max(1, Number(message.limit ?? 24)));
      const before = message.before ? Number(message.before) : Infinity;
      const all = [visit, ...generatedVisits].filter((item) => (!wanted || item.species === wanted) && (!kind || item.kind === kind) && startedMs(item) < before).sort((x, y) => startedMs(y) - startedMs(x));
      const items = all.slice(0, limit);
      result = { items, next: all.length > limit ? startedMs(items[items.length - 1]) : null };
    }
    else if (type === "kestrel/visit" && generatedVisits.some((item) => item.id === message.visit_id)) result = generatedVisits.find((item) => item.id === message.visit_id);
    else if (type === "kestrel/visit" && message.visit_id !== visit.id && message.visit_id !== "fixture-heard-1" && !generatedVisits.some((item) => item.id === message.visit_id)) throw Object.assign(new Error("Not found"), { code: "not_found" });
    else if (type === "kestrel/visit") result = message.visit_id === "fixture-heard-1" ? { ...visit, id: "fixture-heard-1", kind: "heard", species: "Common Raccoon", snapshot: null, crop: null, clip: { state: "none" }, audio: media("audio", "fixture-heard-1"), audioOriginal: media("audio-original", "fixture-heard-1"), audioInfo: { state: "ready", segment: { start: 3.2, end: 8.1 }, cleaned: true, method: "gate" }, heard: null } : visit;
    else if (type === "kestrel/visit/correct" && generatedVisits.some((item) => item.id === message.visit_id)) {
      const at = generatedVisits.findIndex((item) => item.id === message.visit_id);
      const target = String(message.species ?? "unknown");
      generatedVisits[at] = { ...generatedVisits[at], species: target === "not_animal" ? "Not an animal" : target === "unknown" ? "Unidentified animal" : target, status: target === "not_animal" ? "not_animal" : target === "unknown" ? "unknown" : "corrected" };
      result = generatedVisits[at];
    }
    else if (type === "kestrel/visit/correct") {
      previousVisit = visit;
      const target = String(message.species ?? "unknown");
      visit = { ...visit, species: target === "not_animal" ? "Not an animal" : target === "unknown" ? "Unidentified animal" : target, status: target === "not_animal" ? "not_animal" : target === "unknown" ? "unknown" : "corrected" };
      result = visit;
    } else if (type === "kestrel/visit/confirm") {
      previousVisit = visit;
      visit = { ...visit, status: "confirmed" };
      result = visit;
    } else if (type === "kestrel/visit/undo") {
      if (previousVisit) visit = previousVisit;
      previousVisit = null;
      result = { ok: true };
    } else if (type === "kestrel/review") result = { items: [...(visit.status === "auto" ? [visit] : []), ...tieredVisits.filter((item) => item.tier === "check")] };
    else if (type === "kestrel/species") result = species;
    else if (type === "kestrel/species/detail") result = species.find((item) => item.species === message.species) ?? species[0];
    else if (type === "kestrel/species/reference") result = referenceAnswer(String(message.species ?? ""));
    else if (type === "kestrel/labels") result = species.map((item) => item.species).concat(["House Finch", "Blue Jay", "Common Raccoon"]);
    else if (type === "kestrel/health") result = health;
    else if (type === "kestrel/settings/get") result = settings;
    else if (type === "kestrel/settings/set") { settings = message.settings as Settings; result = settings; }
    else if (type === "kestrel/range_filter/get") result = rangeFilter;
    else if (type === "kestrel/range_filter/set") {
      const threshold = Number(message.threshold);
      rangeFilter = { ...rangeFilter, threshold, speciesCount: Math.round(4.5 / threshold), updatedAt: new Date().toISOString() };
      result = rangeFilter;
    }
    else if (type === "kestrel/clips/storage" || type === "kestrel/clips/delete") {
      if (setting("clipfail") === "1") throw new Error("Kestrel's camera recorder isn't answering");
      const admin = setting("admin") !== "0";
      if (type === "kestrel/clips/storage") {
        const covered = message.older_than === undefined ? clips : clips.filter((clip) => clip.startedAt < Number(message.older_than));
        result = { ...sumClips(covered), oldestAt: covered.length ? Math.min(...covered.map((clip) => clip.startedAt)) : null, byReason: { notAnimal: sumClips(covered.filter((clip) => clip.notAnimal)), unconfirmed: sumClips(covered.filter((clip) => clip.unconfirmed)) }, canDelete: admin };
      } else {
        if (!admin) throw Object.assign(new Error("Only a Home Assistant administrator can delete clips"), { code: "unauthorized" });
        const gone = Array.isArray(message.visit_ids) ? [] : message.older_than !== undefined ? clips.filter((clip) => clip.startedAt < Number(message.older_than)) : clips.filter((clip) => clip.notAnimal);
        clips = clips.filter((clip) => !gone.includes(clip));
        let deleted = gone.length;
        let freedBytes = sumClips(gone).bytes;
        if (Array.isArray(message.visit_ids) && message.visit_ids.includes(visit.id) && visit.clip.state === "ready") {
          visit = { ...visit, clip: { state: "deleted", deletedBy: "user" } };
          deleted = 1;
          freedBytes = 4_200_000;
        }
        result = { deleted, freedBytes };
      }
    }
    else throw new Error(`Unexpected fixture command: ${type}`);
  return result;
}

const WS_TYPES = ["kestrel/cameras", "kestrel/visits", "kestrel/visit", "kestrel/visit/correct", "kestrel/visit/confirm", "kestrel/visit/undo", "kestrel/review", "kestrel/species", "kestrel/species/detail", "kestrel/species/reference", "kestrel/labels", "kestrel/health", "kestrel/settings/get", "kestrel/settings/set", "kestrel/range_filter/get", "kestrel/range_filter/set", "kestrel/clips/storage", "kestrel/clips/delete"];
let ha: MiniHa;
let readyTimer: number | undefined;

function pushEvent(event: { type: string; data: unknown }): void {
  ha.mock.connection.push({ type: "event", event: signed(event) });
}
function readyClip(): void {
  visit = { ...visit, clip: { ...visit.clip, state: "ready", url: media("clip", visit.id) } };
  pushEvent({ type: "visit_updated", data: { id: visit.id } });
}
function showVisit(): void {
  window.clearTimeout(readyTimer);
  visit = createVisit();
  haNavigate(`${PANEL_PREFIX}/visit?v=${encodeURIComponent(visit.id)}`);
  readyTimer = window.setTimeout(readyClip, 5_000);
}

function sidebarFromQuery(): DockedSidebar {
  const wanted = setting("sidebar");
  return wanted === "auto" || wanted === "always_hidden" ? wanted : "docked";
}
function safeFromQuery(): [number, number, number, number] | undefined {
  const parts = (setting("safe") ?? "").split(",").map(Number);
  return parts.length === 4 && parts.every(Number.isFinite) ? [parts[0], parts[1], parts[2], parts[3]] : undefined;
}

// ---- Scrypted's card, stood in -----------------------------------------------------------------------------------------
// Camera 168 never gets a picture; camera 240 renders no <video> at all.
if (!customElements.get("scrypted-nvr-camera")) customElements.define("scrypted-nvr-camera", class extends HTMLElement {
  hass?: unknown;
  private config: Record<string, unknown> = {};
  private timer?: number;
  setConfig(config: Record<string, unknown>): void { this.config = config; }
  connectedCallback(): void {
    const id = String(this.config.id);
    const root = this.shadowRoot ?? this.attachShadow({ mode: "open" });
    root.innerHTML = id === "240" ? `<style>:host{display:block}canvas{display:block;width:100%;aspect-ratio:16/9;background:#345}</style><canvas></canvas>` : `<style>:host{display:block}video{display:block;width:100%;aspect-ratio:16/9;background:#123}</style><video muted autoplay playsinline></video>`;
    if (id === "240" || id === "168") return;
    this.timer = window.setTimeout(() => {
      const video = root.querySelector("video");
      if (!video || !this.isConnected) return;
      const canvas = document.createElement("canvas");
      const sharp = this.config.destination === "local";
      canvas.width = sharp ? 1280 : 640;
      canvas.height = sharp ? 720 : 360;
      const context = canvas.getContext("2d") as CanvasRenderingContext2D;
      const draw = (): void => {
        context.fillStyle = `hsl(${(Number(id) * 37) % 360} 45% 38%)`;
        context.fillRect(0, 0, 640, 360);
        context.fillStyle = "#fff";
        context.font = "bold 36px system-ui";
        context.fillText(`Camera ${id} · ${String(this.config.destination)}`, 24, 64);
        context.fillRect((Date.now() / 6) % 600, 300, 40, 12);
      };
      draw();
      video.srcObject = canvas.captureStream(10);
      void video.play().catch(() => undefined);
      this.timer = window.setInterval(draw, 100);
    }, this.config.destination === "local" ? 1200 : 500);
  }
  disconnectedCallback(): void { window.clearTimeout(this.timer); window.clearInterval(this.timer); }
});


// ---- the mini Home Assistant and its control surface -------------------------------------------------------------------
declare global {
  interface Window {
    __emit: (event: { type: string; data: unknown }) => void;
    __setEpoch?: (epoch: number) => void;
    __ha: HaControl;
  }
}

/** What a test (or the dev toolbar) drives: everything Home Assistant would do to the panel from the outside. */
interface HaControl {
  /** Switch theme live; a new `hass` is delivered. */
  setTheme(name: string): void;
  /** The websocket drops: last data stays, `hass.connected` is false, commands fail with code 3. */
  disconnect(): void;
  reconnect(): void;
  /** Home Assistant restarts: the signing secret changes (epoch + 1), the socket drops now and returns after `downMs`. Resolves after the reconnect. */
  restart(options?: { downMs?: number }): Promise<void>;
  /** The signing secret changes WITHOUT the socket dropping (epoch + 1): links held from before are refused from now on, nothing announces it. */
  rotateKey(): void;
  /** Signing epoch: media links returned from now on carry `?authSig=e<epoch>`. */
  readonly epoch: number;
  readonly hass: unknown;
  readonly theme: string;
  readonly subscriptions: number;
  /** Every websocket command the panel sent (type, time, epoch, when the fake server answered), oldest first. */
  readonly calls: ReadonlyArray<{ type: string; at: number; epoch: number; answeredAt: number | null }>;
  setSidebar(mode: DockedSidebar): void;
  setKiosk(enable: boolean): void;
}

// Pushes an event the way the integration would (to the panel's `kestrel/subscribe` stream).
window.__emit = pushEvent;
if (location.pathname === "/" || location.pathname === "/dev/" || location.pathname === "/dev/index.html") history.replaceState(history.state, "", `${PANEL_PREFIX}/live${location.search}${location.hash}`);

const calls: Array<{ type: string; at: number; epoch: number; answeredAt: number | null }> = [];
ha = mountHa({ theme: themeFromQuery(setting("theme")), sidebar: sidebarFromQuery(), kiosk: setting("kiosk") === "1", safe: safeFromQuery(), setup: (mock) => { for (const type of WS_TYPES) mock.onWS(type, async (message) => { const call = { type, at: Date.now(), epoch, answeredAt: null as number | null }; calls.push(call); await delay(LATENCY_MS + (type === "kestrel/clips/delete" ? Number(setting("clipdelay") ?? 0) : 0)); const reply = signed(answer(message)); call.answeredAt = Date.now(); return reply; }); }, create: () => document.createElement("kestrel-panel") });
if (setting("admin") === "0") ha.mock.update({ user: { is_admin: false, name: "Guest" } });

let restartTimer: number | undefined;
window.__ha = {
  setTheme: (name) => { ha.setTheme(name as (typeof THEME_NAMES)[number]); remember("theme", name); },
  disconnect: () => ha.disconnect(),
  reconnect: () => { window.clearTimeout(restartTimer); ha.reconnect(); },
  restart: async ({ downMs = 1500 } = {}) => {
    epoch += 1;
    remember("epoch", String(epoch));
    window.__setEpoch?.(epoch);
    ha.disconnect();
    window.clearTimeout(restartTimer);
    await new Promise<void>((done) => { restartTimer = window.setTimeout(() => { ha.reconnect(); done(); }, downMs); });
  },
  rotateKey: () => {
    epoch += 1;
    remember("epoch", String(epoch));
    window.__setEpoch?.(epoch);
  },
  get epoch() { return epoch; },
  get hass() { return ha.mock.hass; },
  get theme() { return ha.theme; },
  get subscriptions() { return ha.mock.connection.subscriptionCount; },
  get calls() { return calls; },
  setSidebar: (mode) => ha.setSidebar(mode),
  setKiosk: (enable) => ha.setKiosk(enable),
};
window.__setEpoch?.(epoch);

// Small dev toolbar (only with ?toolbar=1, so it never covers the panel in a test).
if (setting("toolbar") === "1") {
  const bar = document.createElement("div");
  bar.setAttribute("aria-label", "Fixture controls");
  bar.style.cssText = "position:fixed;left:8px;bottom:8px;z-index:2147483000;display:flex;flex-wrap:wrap;gap:6px;max-width:calc(100vw - 16px);padding:6px;border-radius:12px;background:rgba(20,20,28,.85);font:12px system-ui";
  const actions: Array<[string, () => void]> = [
    ["Live", () => haNavigate(`${PANEL_PREFIX}/live`)],
    ["Wildlife", () => haNavigate(`${PANEL_PREFIX}/wildlife`)],
    ["AI check-up", () => haNavigate(`${PANEL_PREFIX}/insights`)],
    ["Processing visit", showVisit],
    ["Theme", () => { const names = THEME_NAMES; window.__ha.setTheme(names[(names.indexOf(ha.theme) + 1) % names.length]); }],
    ["Restart HA", () => { void window.__ha.restart(); }],
  ];
  for (const [label, run] of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.style.cssText = "min-height:32px;padding:0 10px;border:1px solid #888;border-radius:999px;color:#fff;background:transparent;cursor:pointer";
    button.addEventListener("click", run);
    bar.append(button);
  }
  document.body.append(bar);
}
