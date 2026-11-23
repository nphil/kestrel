// The one subscription to Kestrel's reports that every dashboard card shares (src/push.ts).
// Node runs the TypeScript files as they are:  cd dashboard && npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { RETRY_MS, SETTLE_MS, onVisitChange } from "../src/push.ts";

/** A Home Assistant connection that records what is asked of it. `failFirst`: how many subscriptions are refused before one works. `hold`: the subscription waits until `release()`. */
function fakeConnection({ failFirst = 0, hold = false } = {}) {
  const readyListeners = new Set();
  const subscriptions = [];
  let attempts = 0;
  let letGo;
  const gate = new Promise((resolve) => { letGo = resolve; });
  const connection = {
    addEventListener(type, listener) { if (type === "ready") readyListeners.add(listener); },
    removeEventListener(type, listener) { if (type === "ready") readyListeners.delete(listener); },
    async subscribeMessage(callback, message, options) {
      attempts += 1;
      if (attempts <= failFirst) throw new Error("Kestrel is not loaded yet");
      if (hold) await gate;
      const entry = { callback, message, options, live: true };
      subscriptions.push(entry);
      return async () => { entry.live = false; };
    },
  };
  return {
    hass: { connection },
    subscriptions,
    get attempts() { return attempts; },
    get readyListeners() { return readyListeners.size; },
    release: () => letGo(),
    reconnect: () => { for (const listener of [...readyListeners]) listener(connection); },
    report(type) { for (const entry of subscriptions.filter((each) => each.live)) entry.callback({ type: "event", event: { type, data: {} } }); },
  };
}

const settled = () => new Promise((resolve) => setImmediate(resolve));

/** Runs `body` with a clock that only moves when told to; whoever is still listening when it ends is stopped, and the pending timers are let go, so one test cannot leak into the next. */
async function scenario(t, body) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const stops = [];
  const listen = (hass, listener) => {
    const stop = onVisitChange(hass, listener);
    stops.push(stop);
    return stop;
  };
  try {
    await body(listen, (ms) => t.mock.timers.tick(ms));
  } finally {
    for (const stop of stops) stop();
    t.mock.timers.tick(RETRY_MS + SETTLE_MS);
    await settled();
  }
}

test("any number of cards share one subscription to Kestrel", async (t) => {
  await scenario(t, async (listen) => {
    const ha = fakeConnection();
    listen(ha.hass, () => undefined);
    listen(ha.hass, () => undefined);
    listen(ha.hass, () => undefined);
    await settled();
    assert.equal(ha.attempts, 1);
    assert.equal(ha.subscriptions.length, 1);
    assert.deepEqual(ha.subscriptions[0].message, { type: "kestrel/subscribe" });
    assert.deepEqual(ha.subscriptions[0].options, { resubscribe: false });
  });
});

test("every card hears that a visit was added, changed or removed", async (t) => {
  await scenario(t, async (listen, tick) => {
    const ha = fakeConnection();
    const heard = [];
    listen(ha.hass, () => heard.push("one"));
    listen(ha.hass, () => heard.push("two"));
    await settled();
    for (const type of ["visit_new", "visit_updated", "visit_deleted"]) {
      ha.report(type);
      tick(SETTLE_MS);
    }
    assert.deepEqual(heard, ["one", "two", "one", "two", "one", "two"]);
  });
});

test("a burst of reports is heard once, a moment after it began", async (t) => {
  await scenario(t, async (listen, tick) => {
    const ha = fakeConnection();
    let heard = 0;
    listen(ha.hass, () => { heard += 1; });
    await settled();
    ha.report("visit_updated");
    tick(SETTLE_MS - 1);
    ha.report("visit_updated");
    ha.report("visit_new");
    assert.equal(heard, 0);
    tick(1);
    assert.equal(heard, 1);
    tick(SETTLE_MS * 3);
    assert.equal(heard, 1); // nothing more was reported
    ha.report("visit_updated");
    tick(SETTLE_MS);
    assert.equal(heard, 2);
  });
});

test("reports that cannot change a card are not heard", async (t) => {
  await scenario(t, async (listen, tick) => {
    const ha = fakeConnection();
    let heard = 0;
    listen(ha.hass, () => { heard += 1; });
    await settled();
    ha.report("camera");
    ha.report("something_new");
    ha.subscriptions[0].callback(undefined);
    ha.subscriptions[0].callback({ type: "event" });
    tick(SETTLE_MS * 2);
    assert.equal(heard, 0);
  });
});

test("a card that stopped listening hears nothing more, and the subscription ends with the last card", async (t) => {
  await scenario(t, async (listen, tick) => {
    const ha = fakeConnection();
    const heard = [];
    const stopOne = listen(ha.hass, () => heard.push("one"));
    const stopTwo = listen(ha.hass, () => heard.push("two"));
    await settled();
    ha.report("visit_new");
    stopOne();
    tick(SETTLE_MS);
    assert.deepEqual(heard, ["two"]);
    assert.equal(ha.subscriptions[0].live, true);
    assert.equal(ha.readyListeners, 1);
    stopTwo();
    await settled();
    assert.equal(ha.subscriptions[0].live, false);
    assert.equal(ha.readyListeners, 0);
  });
});

test("a card that comes back after all had left subscribes again", async (t) => {
  await scenario(t, async (listen) => {
    const ha = fakeConnection();
    const stop = listen(ha.hass, () => undefined);
    await settled();
    stop();
    await settled();
    listen(ha.hass, () => undefined);
    await settled();
    assert.equal(ha.subscriptions.length, 2);
    assert.equal(ha.subscriptions[0].live, false);
    assert.equal(ha.subscriptions[1].live, true);
  });
});

test("while Kestrel does not answer, the subscription is tried again every minute", async (t) => {
  await scenario(t, async (listen, tick) => {
    const ha = fakeConnection({ failFirst: 2 });
    listen(ha.hass, () => undefined);
    await settled();
    assert.equal(ha.attempts, 1);
    tick(RETRY_MS - 1);
    await settled();
    assert.equal(ha.attempts, 1);
    tick(1);
    await settled();
    assert.equal(ha.attempts, 2);
    tick(RETRY_MS);
    await settled();
    assert.equal(ha.attempts, 3);
    assert.equal(ha.subscriptions.length, 1);
    tick(RETRY_MS * 3);
    await settled();
    assert.equal(ha.attempts, 3); // it works now: no more asking
  });
});

test("nobody listens any more: the subscription is not tried again", async (t) => {
  await scenario(t, async (listen, tick) => {
    const ha = fakeConnection({ failFirst: 99 });
    const stop = listen(ha.hass, () => undefined);
    await settled();
    stop();
    tick(RETRY_MS * 3);
    await settled();
    assert.equal(ha.attempts, 1);
  });
});

test("a subscription that is made after everyone left is ended at once", async (t) => {
  await scenario(t, async (listen) => {
    const ha = fakeConnection({ hold: true });
    const stop = listen(ha.hass, () => undefined);
    await settled();
    stop();
    ha.release();
    await settled();
    assert.equal(ha.subscriptions.length, 1);
    assert.equal(ha.subscriptions[0].live, false);
  });
});

test("after a reconnect there is a new subscription, and every card asks again", async (t) => {
  await scenario(t, async (listen, tick) => {
    const ha = fakeConnection();
    let heard = 0;
    listen(ha.hass, () => { heard += 1; });
    await settled();
    ha.reconnect();
    await settled();
    assert.equal(ha.subscriptions.length, 2);
    assert.equal(ha.subscriptions[0].live, true); // it died with the old socket; ending it could end somebody else's
    assert.equal(heard, 0);
    tick(SETTLE_MS);
    assert.equal(heard, 1);
    ha.report("visit_new"); // the new subscription is the one that is heard
    tick(SETTLE_MS);
    assert.equal(heard, 2);
  });
});

test("another connection replaces the first, and the cards already listening hear it", async (t) => {
  await scenario(t, async (listen, tick) => {
    const first = fakeConnection();
    const second = fakeConnection();
    let heard = 0;
    listen(first.hass, () => { heard += 1; });
    await settled();
    listen(second.hass, () => undefined);
    await settled();
    assert.equal(first.subscriptions[0].live, false);
    assert.equal(first.readyListeners, 0);
    assert.equal(second.subscriptions.length, 1);
    second.report("visit_new");
    tick(SETTLE_MS);
    assert.equal(heard, 1);
  });
});
