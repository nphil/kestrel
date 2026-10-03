#!/usr/bin/env node
// A signed media link stops working WITHOUT the websocket dropping (Home Assistant's signing key was replaced, or the link ran out
// after its 12 hours) and the panel is not told. It must fetch fresh links instead of trying the old ones again and again.
//   taskset -c 0-4,8-12 nice -n 15 node dev/smoke/fixture-stale-link.mjs [--size 390x844] [--theme flat-light]
// Needs `node dev/build.mjs` first. Two situations (the reconnect path itself is dev/smoke/fixture-reconnect.mjs):
//   (a) the visit clip: the <video> is refused (401). Within 5 s the video carries the NEW epoch and plays; afterwards nothing asks
//       for the old link again.
//   (b) a recording player whose link has run out (its token says so, so nobody is asked): pressing it makes the panel fetch fresh links
//       at once; the player carries the new epoch within 5 s.
import { runSmoke, MEDIA_PATH } from "./lib/fixture.mjs";

const RECOVER_MS = 5000;
const IDLE_MS = 3000;

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
/** A link as Home Assistant signs them, whose token ran out an hour ago. */
const expiredLink = `${MEDIA_PATH}birdnet_audio/360?authSig=${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ iss: "x", path: "/p", params: [], iat: 1, exp: Math.floor(Date.now() / 1000) - 3600 })}.sig`;

const epochOf = (url) => { const match = /authSig=e(\d+)/.exec(url ?? ""); return match ? Number(match[1]) : -1; };
const oldRequests = (fx, epoch) => fx.media.log.length && [...fx.media.perEpoch.entries()].filter(([e]) => e < epoch).reduce((sum, [, entry]) => sum + entry.requests, 0);

await runSmoke("fixture-stale-link", async (fx) => {
  // (a) the clip
  await fx.open("/kestrel/visit?v=fx-seen-eastern-gray-squirrel-0", { epoch: 0 });
  const video = () => fx.ev((deep, media) => { const el = deep(window.__panelRoot(), "video")[0]; return el ? { src: el.currentSrc || el.src || "", ok: el.error === null } : null; }, MEDIA_PATH);
  await fx.poll(async () => (await video())?.src.includes(MEDIA_PATH), { timeout: 15000 });
  await fx.settle(1200);
  const base = await video();
  await fx.check("(a) baseline: the clip has a link of e0 and no error", !!base && epochOf(base.src) === 0 && base.ok, base ? `e${epochOf(base.src)}` : "no <video>");

  await fx.page.evaluate(() => { window.__ha.rotateKey(); }); // the socket stays up: nothing announces it
  const rotated = fx.epoch;
  const callsBefore = await fx.page.evaluate(() => window.__ha.calls.length);
  const oldBefore = oldRequests(fx, rotated);
  await fx.page.evaluate(() => { window.__deep(window.__panelRoot(), "video")[0]?.load(); }); // the browser asks for the clip again: refused
  const recovered = await fx.poll(async () => { const now = await video(); return now && epochOf(now.src) === rotated && now.ok ? now : null; }, { timeout: RECOVER_MS });
  await fx.check(`(a) a refused clip: within ${RECOVER_MS / 1000} s the video carries e${rotated} and has no error`, !!recovered, recovered ? `e${epochOf(recovered.src)}` : JSON.stringify(await video()));
  const calls = await fx.page.evaluate((from) => window.__ha.calls.slice(from).map((call) => call.type), callsBefore);
  await fx.check("(a) fresh links came from the server (kestrel/visit asked again)", calls.includes("kestrel/visit") || calls.includes("kestrel/visits"), calls.join(", ") || "no calls");
  await fx.settle(IDLE_MS);
  const afterIdle = oldRequests(fx, rotated);
  await fx.check("(a) the old link is not tried again and again (at most 3 requests with it: the clip, the check, a poster)", afterIdle - oldBefore <= 3, `${afterIdle - oldBefore} requests with an old link`);
  const settled = oldRequests(fx, rotated);
  await fx.settle(IDLE_MS);
  await fx.check(`(a) nothing asks for an old link in the next ${IDLE_MS / 1000} s`, oldRequests(fx, rotated) === settled, `${oldRequests(fx, rotated) - settled} requests`);

  // (b) a player whose link ran out
  await fx.open("/kestrel/visit?v=fx-heard-blue-jay-0", { epoch: fx.epoch });
  const player = () => fx.ev((deep) => { const el = deep(window.__panelRoot(), "kestrel-lu-audio-player")[0]; return el ? { src: typeof el.src === "string" ? el.src : "", original: typeof el.original === "string" ? el.original : "" } : null; });
  await fx.poll(async () => (await player())?.src.includes(MEDIA_PATH), { timeout: 15000 });
  await fx.settle(1200);
  const start = await player();
  await fx.check("(b) baseline: the player has a link of the current epoch", !!start && epochOf(start.src) === fx.epoch, start ? `e${epochOf(start.src)}` : "no player");
  await fx.page.evaluate(() => { window.__ha.rotateKey(); });
  const epoch2 = fx.epoch;
  const calls2 = await fx.page.evaluate(() => window.__ha.calls.length);
  await fx.page.evaluate((link) => { window.__deep(window.__panelRoot(), "kestrel-lu-audio-player")[0].src = link; }, expiredLink);
  await fx.settle(600);
  await fx.check("(b) a link that ran out alone does not make the panel fetch (nothing was pressed)", (await fx.page.evaluate(() => window.__ha.calls.length)) === calls2);
  await fx.page.evaluate(() => { window.__deep(window.__panelRoot(), "kestrel-lu-audio-player")[0].dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true })); });
  const fresh = await fx.poll(async () => { const now = await player(); return now && epochOf(now.src) === epoch2 ? now : null; }, { timeout: RECOVER_MS });
  await fx.check(`(b) pressing it: within ${RECOVER_MS / 1000} s the player carries e${epoch2}`, !!fresh, fresh ? `e${epochOf(fresh.src)}` : JSON.stringify(await player()));
}, { watchdogSeconds: 240 });
