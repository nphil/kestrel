import "../src/main.ts";
import { navigate } from "../src/api.ts";
import type { Camera, Health, HomeAssistant, Settings, Species, Visit } from "../src/types.ts";

const now = Date.now();
const media = "/dev/fixtures/placeholder.svg";
const cameras: Camera[] = [
  { id: 88, name: "Backyard", nvrCardId: 88, online: true, health: "ok", drops1h: 0, wildlife: true, lastDetection: { species: "Northern Cardinal", at: now - 3_000, visitId: "fixture-visit-1", kind: "seen", grp: "bird" } },
  { id: 103, name: "Back Door", nvrCardId: 103, online: true, health: "ok", drops1h: 1, wildlife: true, lastDetection: { species: "Blue Jay", at: now - 180_000, visitId: "fx-heard-blue-jay-0", kind: "heard", grp: "bird" } },
  { id: 104, name: "Front Door", nvrCardId: 104, online: true, health: "unstable", drops1h: 4, wildlife: true, lastDetection: { species: "Eastern Gray Squirrel", at: now - 30_000, visitId: "fx-seen-eastern-gray-squirrel-0", kind: "seen", grp: "mammal" } },
  { id: 105, name: "Plant Room", nvrCardId: 105, online: true, health: "ok", drops1h: 0, wildlife: false, lastDetection: { species: "House Mouse", at: now - 30 * 3_600_000, visitId: "fx-seen-house-mouse-0", kind: "seen", grp: "mammal" } },
  { id: 106, name: "Bird", nvrCardId: null, online: true, health: "ok", drops1h: 0, wildlife: true, lastDetection: null },
  { id: 108, name: "Tool Room", nvrCardId: null, online: true, health: "ok", drops1h: 0, wildlife: false, lastDetection: null },
  { id: 128, name: "Office", nvrCardId: null, online: true, health: "ok", drops1h: 0, wildlife: false, lastDetection: null },
  { id: 168, name: "Gym", nvrCardId: 168, online: true, health: "ok", drops1h: 0, wildlife: false, lastDetection: null },
  { id: 196, name: "Downstairs Door", nvrCardId: null, online: false, health: "offline", drops1h: 2, wildlife: false, lastDetection: null },
  { id: 240, name: "Plant Room Cat Feeder", nvrCardId: 240, online: true, health: "ok", drops1h: 0, wildlife: true, lastDetection: null },
];
const createVisit = (): Visit => ({
  id: "fixture-visit-1", camera: { id: 88, name: "Backyard" }, kind: "seen", startedAt: new Date(now - 18_000).toISOString(), species: "Northern Cardinal", grp: "bird", status: "auto", score: 0.91,
  snapshot: media, crop: media, clip: { state: "pending", expectedReadyAt: new Date(Date.now() + 10_000).toISOString() },
  heard: { visitId: "fixture-heard-1", species: "Northern Cardinal", hasAudio: true }, suggestions: [{ species: "Northern Cardinal", why: "model" }, { species: "House Finch", why: "usual" }], firstEver: true, muted: false,
});
let visit = createVisit();
let previousVisit: Visit | null = null;
let settings: Settings = { mutedSpecies: [], heardNotify: "new_only" };
const hours = Array.from({ length: 24 }, (_, hour) => hour >= 7 && hour <= 11 ? 3 : hour >= 17 && hour <= 20 ? 2 : 0);
const iso = (ms: number): string => new Date(ms).toISOString();
const species: Species[] = [
  { species: "Northern Cardinal", grp: "bird", seen: true, heard: true, first: iso(now - 2_000_000), last: iso(now - 18_000), count30d: 28, seenCount30d: 4, heardCount30d: 24, lastSeenAt: now - 18_000, lastHeardAt: now - 900_000, lastSeenCamera: "88", lastHeardCamera: "88", hasPhoto: true, photo_url: media, cameras: { "88": 8, "104": 3, "103": 1 }, hours, newThisYear: true },
  { species: "Eastern Gray Squirrel", grp: "mammal", seen: true, heard: false, first: iso(now - 4_000_000), last: iso(now - 30_000), count30d: 5, seenCount30d: 5, heardCount30d: 0, lastSeenAt: now - 30_000, lastSeenCamera: "104", hasPhoto: true, photo_url: media, cameras: { "104": 5, "88": 2 }, hours: hours.map((n, i) => i < 8 ? n : 0), newThisYear: false },
  { species: "Common Raccoon", grp: "mammal", seen: true, heard: true, first: iso(now - 9_000_000), last: iso(now - 86_000_000), count30d: 6, seenCount30d: 1, heardCount30d: 5, lastSeenAt: now - 86_000_000, lastHeardAt: now - 90_000_000, lastSeenCamera: "88", lastHeardCamera: "103", hasPhoto: false, referenceImage: media, cameras: { "88": 2, "103": 1 }, hours: hours.map((n, i) => i > 19 ? n + 2 : 0), newThisYear: false },
  { species: "Eastern Screech-Owl", grp: "bird", seen: false, heard: true, first: iso(now - 1_000_000), last: iso(now - 500_000), count30d: 5, seenCount30d: 0, heardCount30d: 5, lastHeardAt: now - 500_000, lastHeardCamera: "103", hasPhoto: false, cameras: {}, hours: hours.map((n, i) => i > 20 ? 1 : 0), newThisYear: true },
  { species: "Great Horned Owl", grp: "bird", seen: false, heard: true, first: iso(now - 1_200_000), last: iso(now - 600_000), count30d: 8, seenCount30d: 0, heardCount30d: 8, lastHeardAt: now - 600_000, lastHeardCamera: "88", hasPhoto: false, cameras: {}, hours: hours.map((n, i) => i > 19 ? 1 : 0), newThisYear: true },
  { species: "Blue Jay", grp: "bird", seen: false, heard: true, first: iso(now - 3_000_000), last: iso(now - 180_000), count30d: 12, seenCount30d: 0, heardCount30d: 12, lastHeardAt: now - 180_000, lastHeardCamera: "103", hasPhoto: false, referenceImage: media, cameras: {}, hours, newThisYear: false },
  { species: "Spring Peeper", grp: "other", seen: false, heard: true, first: iso(now - 5_000_000), last: iso(now - 7_200_000), count30d: 3, seenCount30d: 0, heardCount30d: 3, lastHeardAt: now - 7_200_000, lastHeardCamera: "88", hasPhoto: false, cameras: {}, hours: hours.map((n, i) => i > 20 ? 2 : 0), newThisYear: false },
  { species: "House Mouse", grp: "mammal", seen: true, heard: false, first: iso(now - 40 * 3_600_000), last: iso(now - 30 * 3_600_000), count30d: 1, seenCount30d: 1, heardCount30d: 0, lastSeenAt: now - 30 * 3_600_000, lastSeenCamera: "105", hasPhoto: false, cameras: { "105": 1 }, hours: hours.map((n, i) => i === 2 ? 1 : 0), newThisYear: false },
];
const slug = (name: string): string => name.toLowerCase().replace(/[^a-z]+/g, "-");
/** Generated visits so the species sheet has something to page through. Newest first. */
function generated(): Visit[] {
  const out: Visit[] = [];
  for (const item of species) {
    const seen = item.seenCount30d ?? 0;
    const heardCount = item.heardCount30d ?? 0;
    for (let i = 0; i < seen; i += 1) {
      if (item.species === "Northern Cardinal" && i === 0) continue; // the mutable visit stands in for this one
      const at = Number(item.lastSeenAt) - i * 3_600_000;
      out.push({ id: `fx-seen-${slug(item.species)}-${i}`, camera: { id: Number(item.lastSeenCamera ?? 88), name: cameras.find((camera) => String(camera.id) === String(item.lastSeenCamera))?.name ?? "Backyard" }, kind: "seen", startedAt: at, species: item.species, grp: item.grp, status: "auto", score: 0.88, snapshot: media, crop: media, clip: item.species === "Common Raccoon" ? { state: "none" } : { state: "ready", url: "/dev/fixtures/clip.mp4" }, heard: null, suggestions: [], firstEver: false, muted: false });
    }
    for (let i = 0; i < heardCount; i += 1) {
      const at = Number(item.lastHeardAt) - i * 1_800_000;
      out.push({ id: `fx-heard-${slug(item.species)}-${i}`, camera: { id: Number(item.lastHeardCamera ?? 88), name: cameras.find((camera) => String(camera.id) === String(item.lastHeardCamera))?.name ?? "Backyard" }, kind: "heard", startedAt: at, species: item.species, grp: item.grp, status: "auto", score: 0.55 + ((i * 7) % 40) / 100, snapshot: null, crop: null, clip: { state: "none" }, heard: null, audio: i === 3 ? null : "/dev/fixtures/call.mp3", ...(i % 3 === 0 ? { audioOriginal: "/dev/fixtures/call.mp3?original", audioInfo: { state: "ready", segment: { start: 3.2, end: 8.1 }, cleaned: true, method: "gate" } } : i % 3 === 1 ? { audioOriginal: "/dev/fixtures/call.mp3?original", audioInfo: { state: "ready", segment: { start: 1, end: 6.4 }, cleaned: false, method: "trim" } } : { audioInfo: { state: "pending" } }), suggestions: [], firstEver: false, muted: false });
    }
  }
  return out;
}
const generatedVisits = generated();
const startedMs = (item: Visit): number => typeof item.startedAt === "number" ? item.startedAt : Date.parse(item.startedAt);
const health: Health = { detector: { name: "EVA Wildlife", provider: "ONNX", avgMs: 38, checksToday: 124 }, gpu: { usedMiB: 3900, totalMiB: 23040, util: 22 }, cameras: [{ id: 88, checksToday: 80, emptyChecksToday: 11, visitsToday: 4 }, { id: 103, checksToday: 26, emptyChecksToday: 5, visitsToday: 2 }, { id: 104, checksToday: 18, emptyChecksToday: 2, visitsToday: 1 }], storage: { dbMB: 41.4, mediaMB: 98.2, budgetMB: 300 }, birdnet: { online: true, lastHeardAt: new Date(now - 11 * 60_000).toISOString() }, corrections: { total: 18, sinceRetrain: 4 } };
const subscribers = new Set<(message: { type: "event"; event: { type: "visit_new" | "visit_updated" | "camera"; data: unknown } }) => void>();
let readyTimer: number | undefined;
// Lets a test (or the fixture buttons) push an event the way the integration would.
(window as unknown as { __emit: (event: { type: string; data: unknown }) => void }).__emit = (event) => { for (const callback of subscribers) callback({ type: "event", event: event as never }); };

function readyClip(): void {
  visit = { ...visit, clip: { ...visit.clip, state: "ready", url: "/dev/fixtures/clip.mp4" } };
  for (const callback of subscribers) callback({ type: "event", event: { type: "visit_updated", data: { id: visit.id } } });
}
function showVisit(): void {
  window.clearTimeout(readyTimer);
  visit = createVisit();
  navigate("visit", `?v=${encodeURIComponent(visit.id)}`);
  readyTimer = window.setTimeout(readyClip, 5_000);
}

const fakeHass: HomeAssistant = {
  async callWS<T>(message: Record<string, unknown>): Promise<T> {
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
    else if (type === "kestrel/visit") result = message.visit_id === "fixture-heard-1" ? { ...visit, id: "fixture-heard-1", kind: "heard", species: "Common Raccoon", snapshot: null, crop: null, clip: { state: "none" }, audio: "/dev/fixtures/call.mp3", audioOriginal: "/dev/fixtures/call.mp3?original", audioInfo: { state: "ready", segment: { start: 3.2, end: 8.1 }, cleaned: true, method: "gate" }, heard: null } : visit;
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
    return result as T;
  },
  connection: {
    async subscribeMessage<T>(callback: (message: T) => void): Promise<() => Promise<void>> {
      const wrapped = callback as (message: { type: "event"; event: { type: "visit_new" | "visit_updated" | "camera"; data: unknown } }) => void;
      subscribers.add(wrapped);
      return async () => { subscribers.delete(wrapped); };
    },
  },
};

if (!customElements.get("ha-card")) customElements.define("ha-card", class extends HTMLElement {});
if (!customElements.get("ha-icon")) customElements.define("ha-icon", class extends HTMLElement {});
// Stand-in for Scrypted's card. Camera 168 never gets a picture; camera 240 renders no <video> at all.
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

const card = document.createElement("kestrel-cameras") as HTMLElement & { setConfig(config: { type: string; view: "live" }): void; hass: HomeAssistant };
card.setConfig({ type: "custom:kestrel-cameras", view: "live" });
card.hass = fakeHass;
document.querySelector("#root")?.append(card);
document.querySelectorAll<HTMLButtonElement>(".fixture-controls button").forEach((button) => {
  button.addEventListener("click", () => {
    if (button.id === "theme") {
      document.documentElement.classList.toggle("light");
      return;
    }
    if (button.id === "visit") { showVisit(); return; }
    if (button.id === "live" || button.id === "wildlife" || button.id === "insights") {
      navigate(button.id);
    }
  });
});
