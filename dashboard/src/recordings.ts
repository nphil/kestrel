import { stableUrl } from "./urls.ts";

/** What BirdNET-Go says about the weather at the moment of a recording. Any part may be missing; a recording with neither a
 * temperature nor a description has no weather at all (null). `unit` is "°C" or "°F", already in Home Assistant's own units. */
export interface RecordingWeather { temp: number | null; unit: string; conditions: string; icon: string }

/** What goes under a recording: the weather it was made in, and its spectrogram (a picture of the sound, left = start, right = end). */
export interface RecordingExtras { weather: RecordingWeather | null; spectrogram: string | null }

const NONE: RecordingExtras = { weather: null, spectrogram: null };
const ICON = /^mdi:[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FALLBACK_ICON = "mdi:weather-partly-cloudy";

export function readWeather(value: unknown): RecordingWeather | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const temp = typeof raw.temp === "number" && Number.isFinite(raw.temp) ? Math.round(raw.temp) : null;
  const conditions = typeof raw.conditions === "string" ? raw.conditions.trim().slice(0, 60) : "";
  if (temp === null && !conditions) return null;
  const letter = typeof raw.unit === "string" ? /^°?([CF])$/i.exec(raw.unit.trim())?.[1] : undefined;
  return { temp, unit: letter ? `°${letter.toUpperCase()}` : "°", conditions, icon: typeof raw.icon === "string" && ICON.test(raw.icon) ? raw.icon : FALLBACK_ICON };
}

/** "8°C · Clear sky". */
export function weatherText(weather: RecordingWeather): string {
  return [weather.temp === null ? "" : `${weather.temp}${weather.unit}`, weather.conditions].filter(Boolean).join(" · ");
}

/** The answer of `kestrel/recordings` by visit id. Every id the server answered about is in it; one whose parts are missing has `null` for them. */
export function readExtras(value: unknown): Record<string, RecordingExtras> {
  const items = value && typeof value === "object" && "items" in value ? value.items : null;
  const found: Record<string, RecordingExtras> = {};
  if (!items || typeof items !== "object") return found;
  for (const [id, entry] of Object.entries(items)) {
    const raw = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    const link = typeof raw.spectrogram === "string" ? raw.spectrogram.trim() : "";
    found[id] = { weather: readWeather(raw.weather), spectrogram: link ? stableUrl(link) ?? link : null };
  }
  return found;
}

/** The answers kept for this session. A spectrogram link is signed for 12 hours; this keeps it for 30 minutes. A recording the server could not
 * draw yet (not confirmed, BirdNET-Go busy) is asked about again after two minutes. */
const KEEP_MS = 30 * 60_000;
const ASK_AGAIN_MS = 2 * 60_000;
const BATCH = 20;
const known = new Map<string, { at: number; extras: RecordingExtras }>();
const asking = new Map<string, Promise<void>>();

export function knownExtras(id: string, now = Date.now()): RecordingExtras | undefined {
  const hit = known.get(id);
  if (!hit) return undefined;
  if (now - hit.at >= (hit.extras.spectrogram ? KEEP_MS : ASK_AGAIN_MS)) { known.delete(id); return undefined; }
  return hit.extras;
}

/** Forgets every answer: their spectrogram links were signed with a key Home Assistant has since replaced. */
export function forgetExtras(): void {
  known.clear();
}

/** Asks (twenty at a time, and nobody twice) for what the ids are missing. Resolves once every id has an answer, or the ask failed:
 * a failed ask is not remembered, so the next one tries again. */
export function loadExtras(ask: (ids: string[]) => Promise<unknown>, ids: readonly string[]): Promise<void> {
  const unique = [...new Set(ids.filter(Boolean))];
  const waiting = unique.map((id) => asking.get(id)).filter((promise): promise is Promise<void> => promise !== undefined);
  const wanted = unique.filter((id) => !asking.has(id) && knownExtras(id) === undefined);
  for (let at = 0; at < wanted.length; at += BATCH) {
    const batch = wanted.slice(at, at + BATCH);
    const promise = ask(batch).then(
      (answer) => { const read = readExtras(answer); for (const id of batch) known.set(id, { at: Date.now(), extras: read[id] ?? NONE }); },
      () => undefined,
    ).finally(() => { for (const id of batch) asking.delete(id); });
    for (const id of batch) asking.set(id, promise);
    waiting.push(promise);
  }
  return Promise.all(waiting).then(() => undefined);
}

/** How long a picture that was not ready waits before it is asked for again, counted from the try that failed. BirdNET-Go carries on drawing after the server stops
 * waiting, so the first pause is short; the later ones are for a recording that takes long to prepare. Added up it is about eight minutes, then the picture is given up on. */
export const PICTURE_RETRY_MS: readonly number[] = [2_000, 15_000, 45_000, 120_000, 300_000];

/** The pause before the next try, `retries` being how many times the picture has been asked for again so far; `null` when it is time to give up. */
export function pictureRetryDelay(retries: number): number | null {
  return PICTURE_RETRY_MS[retries] ?? null;
}
