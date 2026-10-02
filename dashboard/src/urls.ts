/** Signed media links get a new signature on every response, although the picture behind them doesn't change.
 * Handing the browser a new link makes it download the same picture again (and flash while it does). This
 * keeps the first link seen for each picture while its signature is still comfortably valid (they last 12
 * hours; these are kept for 6). */
const KEEP_MS = 6 * 3_600_000;
const MAX_ENTRIES = 3000;
const known = new Map<string, { url: string; at: number }>();

export function pathOf(url: string): string {
  return url.replace(/([?&])authSig=[^&]*&?/, "$1").replace(/[?&]$/, "");
}

/** True when two links point at the same media, whatever their signatures. */
export function sameMedia(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a) && Boolean(b) && pathOf(a as string) === pathOf(b as string);
}

export function stableUrl(url: string | null | undefined): string | null | undefined {
  if (!url) return url;
  const key = pathOf(url);
  const now = Date.now();
  const hit = known.get(key);
  if (hit && now - hit.at < KEEP_MS) return hit.url;
  known.delete(key);
  known.set(key, { url, at: now });
  if (known.size > MAX_ENTRIES) for (const oldest of [...known.keys()].slice(0, MAX_ENTRIES / 4)) known.delete(oldest);
  return url;
}
