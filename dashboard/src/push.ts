import type { HomeAssistant, KestrelPush } from "./types.ts";

/** An animal that lingers changes its visit many times in a minute. Listeners hear about a burst once, this long after it began. */
export const SETTLE_MS = 5_000;
/** Kestrel does not answer the subscription while Home Assistant is still starting: ask again this often for as long as anyone listens. */
export const RETRY_MS = 60_000;

/** ONE subscription to Kestrel's push events for the whole page, however many cards want to hear them: each extra subscription would make
 * the server sign and send every event again. It starts with the first listener and ends with the last. */
const listeners = new Set<() => void>();
let connection: HomeAssistant["connection"] | undefined;
let unsubscribe: (() => Promise<void>) | undefined;
let turn = 0;
let settling = false;

/** Something may have changed: every listener hears it once, `SETTLE_MS` from now, however many reasons arrive until then. */
function settle(): void {
  if (settling) return;
  settling = true;
  setTimeout(() => {
    settling = false;
    for (const listener of [...listeners]) listener();
  }, SETTLE_MS);
}

function heard(message: KestrelPush): void {
  // A visit was added, changed or removed: that can change a list or a number on a card. (The camera list is on no card.)
  const type = message?.event?.type;
  if (type === "visit_new" || type === "visit_updated" || type === "visit_deleted") settle();
}

async function subscribe(): Promise<void> {
  const mine = connection;
  const mineTurn = ++turn;
  if (!mine) return;
  try {
    // `resubscribe: false`: the library would renew the subscription on its own after a reconnect, and right after Home Assistant starts the
    // integration may not be loaded yet, so that attempt would fail for good. `onReady` asks again once the connection is back.
    const stop = await mine.subscribeMessage<KestrelPush>(heard, { type: "kestrel/subscribe" }, { resubscribe: false });
    if (mineTurn === turn && listeners.size) unsubscribe = stop;
    else void stop().catch(() => undefined); // everyone left, or the connection changed, while the subscription was being made
  } catch {
    setTimeout(() => { if (mineTurn === turn && listeners.size) void subscribe(); }, RETRY_MS);
  }
}

/** The connection came back. The old subscription died with the old socket (and ending it now could end somebody else's), so make a new one;
 * and whatever happened while the connection was down was never reported, so the listeners ask again too. */
function onReady(): void {
  unsubscribe = undefined;
  if (!listeners.size) return;
  void subscribe();
  settle();
}

function release(): void {
  turn += 1; // a subscription still being made, or waiting to be tried again, is dropped
  connection?.removeEventListener("ready", onReady);
  connection = undefined;
  const stop = unsubscribe;
  unsubscribe = undefined;
  void stop?.().catch(() => undefined);
}

/** Calls `listener` (no more than once per `SETTLE_MS`) after a visit was added, changed or removed, and after the connection came back.
 * Returns the function that stops it. */
export function onVisitChange(hass: HomeAssistant, listener: () => void): () => void {
  listeners.add(listener);
  if (connection !== hass.connection) {
    if (connection) release();
    connection = hass.connection;
    connection.addEventListener("ready", onReady);
    void subscribe();
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) release();
  };
}
