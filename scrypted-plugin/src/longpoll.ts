// The events long-poll's `timeout` query parameter is in SECONDS (the plugin <-> integration
// contract: `GET events?after=<seq>&timeout=25`). It was once read as milliseconds, so a client
// asking for 25 s got 25 ms and spun at ~32 requests/second. Kept dependency-free so the unit
// test can import it directly.

export const LONG_POLL_MAX_SECONDS = 25;

// Missing/blank/non-numeric -> the maximum wait (a malformed value must never turn into a hot
// loop); otherwise seconds clamped to 0..25 and converted to milliseconds. 0 means "don't wait".
export function parseLongPollTimeoutMs(raw: string | null | undefined): number {
    if (raw === null || raw === undefined || raw.trim() === '')
        return LONG_POLL_MAX_SECONDS * 1000;
    const seconds = Number(raw);
    if (Number.isNaN(seconds))
        return LONG_POLL_MAX_SECONDS * 1000;
    return Math.min(LONG_POLL_MAX_SECONDS, Math.max(0, seconds)) * 1000;
}
