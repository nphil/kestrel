import "../src/main.ts";
import { navigate } from "../src/api.ts";
import type { Camera, Health, HomeAssistant, Settings, Species, Visit } from "../src/types.ts";

const now = Date.now();
const media = "/dev/fixtures/placeholder.svg";
const cameras: Camera[] = [
  { id: 88, name: "Backyard", nvrCardId: 88, online: true, health: "ok", drops1h: 0, wildlife: true, lastDetection: { species: "Northern Cardinal", timestamp: now - 3_000 } },
  { id: 103, name: "Back Door", nvrCardId: 103, online: true, health: "ok", drops1h: 1, wildlife: true, lastDetection: null },
  { id: 104, name: "Front Door", nvrCardId: 104, online: true, health: "unstable", drops1h: 4, wildlife: true, lastDetection: { species: "Eastern Gray Squirrel", timestamp: now - 30_000 } },
  { id: 105, name: "Plant Room", nvrCardId: 105, online: true, health: "ok", drops1h: 0, wildlife: false, lastDetection: null },
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
const species: Species[] = [
  { species: "Northern Cardinal", grp: "bird", seen: true, heard: true, first: new Date(now - 2_000_000).toISOString(), last: new Date(now - 18_000).toISOString(), count30d: 12, hasPhoto: true, photo_url: media, cameras: { "88": 8, "104": 3, "103": 1 }, hours, newThisYear: true },
  { species: "Eastern Gray Squirrel", grp: "mammal", seen: true, heard: false, first: new Date(now - 4_000_000).toISOString(), last: new Date(now - 30_000).toISOString(), count30d: 7, hasPhoto: true, photo_url: media, cameras: { "104": 5, "88": 2 }, hours: hours.map((n, i) => i < 8 ? n : 0), newThisYear: false },
  { species: "Common Raccoon", grp: "mammal", seen: true, heard: true, first: new Date(now - 9_000_000).toISOString(), last: new Date(now - 86_000_000).toISOString(), count30d: 3, hasPhoto: false, cameras: { "88": 2, "103": 1 }, hours: hours.map((n, i) => i > 19 ? n + 2 : 0), newThisYear: false },
];
const health: Health = { detector: { name: "EVA Wildlife", provider: "ONNX", avgMs: 38, checksToday: 124 }, gpu: { usedMiB: 3900, totalMiB: 23040, util: 22 }, cameras: [{ id: 88, checksToday: 80, emptyChecksToday: 11, visitsToday: 4 }, { id: 103, checksToday: 26, emptyChecksToday: 5, visitsToday: 2 }, { id: 104, checksToday: 18, emptyChecksToday: 2, visitsToday: 1 }], storage: { dbMB: 41.4, mediaMB: 98.2, budgetMB: 300 }, birdnet: { online: true, lastHeardAt: new Date(now - 11 * 60_000).toISOString() }, corrections: { total: 18, sinceRetrain: 4 } };
const subscribers = new Set<(message: { type: "event"; event: { type: "visit_new" | "visit_updated" | "camera"; data: unknown } }) => void>();
let readyTimer: number | undefined;

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
    else if (type === "kestrel/visits") result = { items: [visit], next: null };
    else if (type === "kestrel/visit") result = message.visit_id === "fixture-heard-1" ? { ...visit, id: "fixture-heard-1", kind: "heard", audio: "/dev/fixtures/call.mp3", heard: null } : visit;
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
if (!customElements.get("scrypted-nvr-camera")) customElements.define("scrypted-nvr-camera", class extends HTMLElement {
  connectedCallback(): void {
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `<style>:host{display:grid;place-items:center;width:100%;height:100%;min-height:inherit;color:var(--secondary-text-color);background:color-mix(in srgb,var(--primary-color) 12%,var(--card-background-color))}div{display:grid;gap:6px;padding:16px;text-align:center;font:500 13px system-ui}small{font-size:11px}</style><div><strong>Live fixture</strong><small>Camera ${this.getAttribute("id")} · ${this.getAttribute("destination")}</small></div>`;
  }
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
