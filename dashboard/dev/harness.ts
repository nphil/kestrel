import "../src/main.ts";
import { mountHa, themeFromQuery, type DockedSidebar, type MiniHa } from "./ha/mount.ts";
import { PANEL_PREFIX, haNavigate } from "./ha/panel.ts";
import { THEME_NAMES } from "./ha/theme.ts";
import type { Camera, Health, Settings, Species, Visit } from "../src/types.ts";

const now = Date.now();
/** Unsigned media path, the shape of the integration's route (`/api/kestrel/media/<kind>/<id>`). The fake server signs it per response (see `signed`). */
const media = (kind: string, id: string | number): string => `/api/kestrel/media/${kind}/${encodeURIComponent(String(id))}`;
const slug = (name: string): string => name.toLowerCase().replace(/[^a-z]+/g, "-");
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
const hours = Array.from({ length: 24 }, (_, hour) => hour >= 7 && hour <= 11 ? 3 : hour >= 17 && hour <= 20 ? 2 : 0);
const iso = (ms: number): string => new Date(ms).toISOString();
const species: Species[] = [
  { species: "Northern Cardinal", grp: "bird", seen: true, heard: true, first: iso(now - 2_000_000), last: iso(now - 18_000), count30d: 28, seenCount30d: 4, heardCount30d: 24, lastSeenAt: now - 18_000, lastHeardAt: now - 900_000, lastSeenCamera: "88", lastHeardCamera: "88", hasPhoto: true, photo_url: media("species", slug("Northern Cardinal")), cameras: { "88": 8, "104": 3, "103": 1 }, hours, newThisYear: true },
  { species: "Eastern Gray Squirrel", grp: "mammal", seen: true, heard: false, first: iso(now - 4_000_000), last: iso(now - 30_000), count30d: 5, seenCount30d: 5, heardCount30d: 0, lastSeenAt: now - 30_000, lastSeenCamera: "104", hasPhoto: true, photo_url: media("species", slug("Eastern Gray Squirrel")), cameras: { "104": 5, "88": 2 }, hours: hours.map((n, i) => i < 8 ? n : 0), newThisYear: false },
  { species: "Common Raccoon", grp: "mammal", seen: true, heard: true, first: iso(now - 9_000_000), last: iso(now - 86_000_000), count30d: 6, seenCount30d: 1, heardCount30d: 5, lastSeenAt: now - 86_000_000, lastHeardAt: now - 90_000_000, lastSeenCamera: "88", lastHeardCamera: "103", hasPhoto: false, referenceImage: media("reference", slug("Common Raccoon")), cameras: { "88": 2, "103": 1 }, hours: hours.map((n, i) => i > 19 ? n + 2 : 0), newThisYear: false },
  { species: "Eastern Screech-Owl", grp: "bird", seen: false, heard: true, first: iso(now - 1_000_000), last: iso(now - 500_000), count30d: 5, seenCount30d: 0, heardCount30d: 5, lastHeardAt: now - 500_000, lastHeardCamera: "103", hasPhoto: false, cameras: {}, hours: hours.map((n, i) => i > 20 ? 1 : 0), newThisYear: true },
  { species: "Great Horned Owl", grp: "bird", seen: false, heard: true, first: iso(now - 1_200_000), last: iso(now - 600_000), count30d: 8, seenCount30d: 0, heardCount30d: 8, lastHeardAt: now - 600_000, lastHeardCamera: "88", hasPhoto: false, cameras: {}, hours: hours.map((n, i) => i > 19 ? 1 : 0), newThisYear: true },
  { species: "Blue Jay", grp: "bird", seen: false, heard: true, first: iso(now - 3_000_000), last: iso(now - 180_000), count30d: 12, seenCount30d: 0, heardCount30d: 12, lastHeardAt: now - 180_000, lastHeardCamera: "103", hasPhoto: false, referenceImage: media("reference", slug("Blue Jay")), cameras: {}, hours, newThisYear: false },
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
  species.push({ species: name, grp: /Squirrel|Chipmunk|Opossum|Skunk|Deer|Fox|Cottontail/.test(name) ? "mammal" : "bird", seen: true, heard: false, first: iso(seenAt - 3_600_000), last: iso(seenAt), count30d: 3, seenCount30d: 3, heardCount30d: 0, lastSeenAt: seenAt, lastSeenCamera: "88", hasPhoto: index % 2 === 0, ...(index % 2 === 0 ? { photo_url: media("species", slug(name)) } : { referenceImage: media("reference", slug(name)) }), cameras: { "88": 3 }, hours, newThisYear: false });
});
const generatedVisits = generated();
const startedMs = (item: Visit): number => typeof item.startedAt === "number" ? item.startedAt : Date.parse(item.startedAt);
const health: Health = { detector: { name: "EVA Wildlife", provider: "ONNX", avgMs: 38, checksToday: 124 }, gpu: { usedMiB: 3900, totalMiB: 23040, util: 22 }, cameras: [{ id: 88, checksToday: 80, emptyChecksToday: 11, visitsToday: 4 }, { id: 103, checksToday: 26, emptyChecksToday: 5, visitsToday: 2 }, { id: 104, checksToday: 18, emptyChecksToday: 2, visitsToday: 1 }], storage: { dbMB: 41.4, mediaMB: 98.2, budgetMB: 300 }, birdnet: { online: true, lastHeardAt: new Date(now - 11 * 60_000).toISOString() }, corrections: { total: 18, sinceRetrain: 4 } };

// ---- the fake server -------------------------------------------------------------------------------------------------
// Home Assistant signs every media link (`async_sign_path`: path + `?authSig=<token>`), and the secret is new after every restart.
// The harness stands for that with `?authSig=e<epoch>`: a payload built after `__ha.restart()` carries the NEW epoch, a payload fetched
// before keeps the OLD one, and a test's request interceptor answers 401 for an old epoch (see dev/smoke/lib/fixture.mjs).
// Harness settings come from the address on the FIRST load (`?theme= &toolbar=1 &sidebar= &kiosk=1 &safe=t,r,b,l &latency=ms &epoch=N`), are kept
// in sessionStorage for this tab, and are removed from the address, so the panel's own addresses stay exactly /kestrel/<view>[?s=|?v=] and a
// reload keeps the theme and the signing epoch (the server did not restart because the page did).
const SETTINGS_KEY = "kestrel-harness";
const SETTING_NAMES = ["theme", "epoch", "toolbar", "sidebar", "kiosk", "safe", "latency"];
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
    } else if (type === "kestrel/review") result = { items: visit.status === "auto" ? [visit] : [] };
    else if (type === "kestrel/species") result = species;
    else if (type === "kestrel/species/detail") result = species.find((item) => item.species === message.species) ?? species[0];
    else if (type === "kestrel/labels") result = species.map((item) => item.species).concat(["House Finch", "Blue Jay", "Common Raccoon"]);
    else if (type === "kestrel/health") result = health;
    else if (type === "kestrel/settings/get") result = settings;
    else if (type === "kestrel/settings/set") { settings = message.settings as Settings; result = settings; }
    else throw new Error(`Unexpected fixture command: ${type}`);
  return result;
}

const WS_TYPES = ["kestrel/cameras", "kestrel/visits", "kestrel/visit", "kestrel/visit/correct", "kestrel/visit/confirm", "kestrel/visit/undo", "kestrel/review", "kestrel/species", "kestrel/species/detail", "kestrel/labels", "kestrel/health", "kestrel/settings/get", "kestrel/settings/set"];
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
ha = mountHa({ theme: themeFromQuery(setting("theme")), sidebar: sidebarFromQuery(), kiosk: setting("kiosk") === "1", safe: safeFromQuery(), setup: (mock) => { for (const type of WS_TYPES) mock.onWS(type, async (message) => { const call = { type, at: Date.now(), epoch, answeredAt: null as number | null }; calls.push(call); await delay(LATENCY_MS); const reply = signed(answer(message)); call.answeredAt = Date.now(); return reply; }); }, create: () => document.createElement("kestrel-panel") });

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
