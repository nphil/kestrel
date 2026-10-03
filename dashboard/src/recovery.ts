/** What the panel needs to get over a Home Assistant restart.
 *
 * Media links are signed by Home Assistant (`?authSig=`), and the signing key is made again every time it starts, so
 * every link an open panel holds stops working after a restart (HTTP 401) while the page itself carries on. The panel
 * therefore asks the server about one of its links when the connection comes back; only when that link is refused does
 * it throw away what it kept and ask for everything again, so a short Wi-Fi blip changes nothing on screen. */

/** Waits between attempts to get fresh data after a reconnect. Right after Home Assistant starts the Kestrel
 * integration may not be loaded yet, and its commands fail for a few seconds. */
export const RETRY_MS = [2_000, 4_000, 8_000, 15_000, 30_000, 60_000] as const;

/** True for a link Home Assistant signed. */
export function isSigned(url: string | null | undefined): url is string {
  return typeof url === "string" && /[?&]authSig=/.test(url);
}

/** True when a link Home Assistant signed has run out (or runs out within `marginMs`). The signature is a token that names its own
 * expiry (`exp`, seconds), so this asks nobody: a link that is already past it is certain to be refused (401), and trying it anyway
 * only adds a refused request to Home Assistant's log. `false` for a link whose expiry cannot be read. */
export function signedLinkExpired(url: string | null | undefined, marginMs = 0, now = Date.now()): boolean {
  const signature = typeof url === "string" ? /[?&]authSig=([^&#]+)/.exec(url)?.[1] : undefined;
  const payload = signature?.split(".")[1];
  if (!payload) return false;
  try {
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="))) as { exp?: unknown };
    return typeof claims.exp === "number" && claims.exp * 1000 - marginMs <= now;
  } catch {
    return false;
  }
}

/** Asks the server about a signed link without downloading it. `true`: refused (401 or 403), so the signature is dead. `false`: any
 * other answer, or none within `waitMs` (a refusal comes back at once, so a slow answer means the signature was accepted and the server
 * is busy making the picture). `null`: the server could not be reached. */
export async function signatureRejected(url: string, request: typeof fetch = fetch, waitMs = 3_000): Promise<boolean | null> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, waitMs);
  try {
    // Only the status line matters: one byte at most, never from the browser's own cache, and the body is dropped at once.
    const response = await request(url, { headers: { Range: "bytes=0-0" }, cache: "no-store", credentials: "same-origin", signal: controller.signal });
    return response.status === 401 || response.status === 403;
  } catch {
    return timedOut ? false : null;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
