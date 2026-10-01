import type { Camera, Species } from "./types.ts";

/** What the last visit to the panel saw, so the next one starts with real content instead of a blank screen
 * and refreshes it in the background. Media links inside are signed for 12 hours, so an entry is only used
 * for 6 hours after it was saved. */
interface Stored { cameras?: { at: number; data: Camera[] }; species?: { at: number; data: Species[] } }
type Key = keyof Stored;

const STORAGE_KEY = "kestrel.panel.v2";
const MAX_AGE_MS = 6 * 3_600_000;

function read(): Stored {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) as Stored : {};
  } catch { return {}; }
}

export function readCached(key: "cameras"): Camera[] | null;
export function readCached(key: "species"): Species[] | null;
export function readCached(key: Key): Camera[] | Species[] | null {
  const entry = read()[key];
  return entry && Array.isArray(entry.data) && Date.now() - entry.at < MAX_AGE_MS ? entry.data : null;
}

const pending: Stored = {};
let timer = 0;

/** Remembers fresh data. Writes are batched, so a burst of loads costs one write. */
export function writeCached(key: "cameras", data: Camera[]): void;
export function writeCached(key: "species", data: Species[]): void;
export function writeCached(key: Key, data: Camera[] | Species[]): void {
  (pending as Record<Key, { at: number; data: Camera[] | Species[] }>)[key] = { at: Date.now(), data };
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...read(), ...pending })); }
    catch { /* storage full or blocked: the panel works the same without it */ }
  }, 400);
}
