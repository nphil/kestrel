#!/usr/bin/env node
// Home Assistant restarts while the panel is open: signed media links die (the signing secret changes), the websocket drops and returns.
//   taskset -c 0-4,8-12 nice -n 15 node dev/smoke/fixture-reconnect.mjs [--size 390x844] [--theme flat-light]
// Needs `node dev/build.mjs` first. For four situations (Wildlife with the species sheet open, a seen visit, a heard visit, Live with
// snapshot-only cameras) it checks, per situation:
//   (i)   baseline: every visible picture is loaded, audio rows / players / the <video> carry a link;
//   (ii)  `__ha.restart({ downMs: 1500 })`: during the outage the last data stays and a quiet "Reconnecting" strip shows;
//   (iii) within 5 s after the reconnect every visible picture, audio row/player and the visit <video> carry the NEW epoch and are
//         loaded, no picture is failed, no request with the new epoch got a 401;
//   (iv)  the same after RELOADING the page with the OLD persisted copy put back into localStorage (first paint = old data).
// The request interceptor (lib/fixture.mjs) answers 401 for a link signed before the restart; the numbers printed at the end say how
// many such requests really happened.
import { runSmoke, MEDIA_PATH } from "./lib/fixture.mjs";

const DOWN_MS = 1500;
const RECOVER_MS = 5000;

/** What the page shows right now, gathered inside the page (deep through shadow roots). */
const inspect = (fx) => fx.ev((deep, media) => {
  const root = window.__panelRoot();
  if (!root) return null;
  const epochOf = (url) => { const match = /authSig=e(\d+)/.exec(url ?? ""); return match ? Number(match[1]) : -1; };
  const mediaStrings = (value) => Object.values(value ?? {}).filter((v) => typeof v === "string" && v.includes(media));
  const seen = (el) => window.__shown(el) && window.__inViewport(el);
  // A live picture downloads its link with fetch() and shows a blob: URL, so its link is the host's `src`; everything else shows the link itself.
  const linkOf = (img) => { const host = img.getRootNode().host; return host?.localName === "kestrel-live-picture" ? host.getAttribute("src") || host.src || "" : img.currentSrc || img.src; };
  const imgs = deep(root, "img").filter((img) => linkOf(img).includes(media) && seen(img)).map((img) => ({ epoch: epochOf(linkOf(img)), ok: img.complete && img.naturalWidth > 0, src: linkOf(img) }));
  const failed = deep(root, ".fallback").filter((el) => seen(el) && /image|picture/i.test((el.getRootNode().host?.localName) ?? "")).length;
  const rows = deep(root, "kestrel-lu-audio-list").flatMap((list) => (list.rows ?? []).flatMap((row) => mediaStrings(row))).map(epochOf);
  const players = deep(root, "kestrel-lu-audio-player").flatMap((player) => [player.src, player.original].filter((v) => typeof v === "string" && v.includes(media))).map(epochOf);
  const videoEls = deep(root, "video");
  const videos = videoEls.map((video) => video.currentSrc || video.src || "").filter((src) => src.includes(media)).map(epochOf);
  // A <video poster> is the visit hero picture: count it with the pictures (loaded = the video element is not in an error state).
  for (const video of videoEls) if (video.poster?.includes(media) && seen(video)) imgs.push({ epoch: epochOf(video.poster), ok: video.error === null, src: video.poster });
  const livePics = deep(root, "kestrel-live-picture").map((el) => el.getAttribute("src") || el.src || "").filter((src) => src.includes(media)).map(epochOf);
  const players2 = deep(root, "audio").filter((audio) => audio.getRootNode().host?.localName === "kestrel-lu-audio-player").map((audio) => audio.currentSrc || audio.src || "").filter((src) => src.includes(media)).map(epochOf);
  players.push(...players2);
  // The quiet strip ("Reconnecting…", bottom slot) is not an error or blank screen; any other state element is.
  const states = deep(root, "kestrel-lu-state").filter((el) => window.__shown(el));
  const isStrip = (el) => el.getAttribute("slot") === "bottom" || /reconnect/i.test(el.getAttribute("message") ?? "");
  const stateKinds = states.filter((el) => !isStrip(el)).map((el) => el.getAttribute("kind") ?? "");
  const reconnecting = states.some(isStrip) || deep(root, "*").some((el) => window.__shown(el) && [...el.childNodes].some((n) => n.nodeType === 3 && /reconnect/i.test(n.textContent ?? "")));
  const count = (selector) => deep(root, selector).filter((el) => window.__shown(el)).length;
  return { imgUrls: imgs.map((img) => img.src), rowUrls: deep(root, "kestrel-lu-audio-list").flatMap((list) => (list.rows ?? []).flatMap((row) => mediaStrings(row))), imgs, failed, rows, players, videos, livePics, stateKinds, reconnecting, tiles: count("button.species-tile"), cameras: count("article.camera-tile"), view: root.querySelector("kestrel-lu-view-stack")?.current ?? null };
}, MEDIA_PATH);

const state_show = (fx, state) => state.show?.(fx);

const STATES = [
  {
    id: "wildlife + species sheet",
    path: "/kestrel/wildlife",
    async prepare(fx) {
      await fx.poll(async () => (await fx.panel.count("button.species-tile")) > 0, { timeout: 15000 });
      await fx.page.locator('button.species-tile[aria-label^="Northern Cardinal."]').first().click({ timeout: 10000 });
      await fx.poll(() => fx.panel.speciesOpen(), { timeout: 6000 });
      await fx.poll(async () => ((await inspect(fx))?.rows.length ?? 0) > 0, { timeout: 10000 });
    },
  },
  { id: "seen visit", path: "/kestrel/visit?v=fx-seen-eastern-gray-squirrel-0", async prepare(fx) { await fx.poll(async () => (await inspect(fx))?.imgs.length > 0, { timeout: 15000 }); } },
  { id: "heard visit", path: "/kestrel/visit?v=fx-heard-blue-jay-0", async prepare(fx) { await fx.poll(async () => (await inspect(fx))?.players.length > 0, { timeout: 15000 }); } },
  {
    id: "live, snapshot-only cameras",
    path: "/kestrel/live",
    // The snapshot-only tiles sit below the first screenful: bring them into view (a picture is only fetched once it is near the screen).
    async show(fx) { await fx.page.evaluate(() => window.__deep(window.__panelRoot(), "kestrel-live-picture")[0]?.scrollIntoView({ block: "center" })); await fx.settle(300); },
    async prepare(fx) { await state_show(fx, this); await fx.poll(async () => (await inspect(fx))?.imgs.length > 0, { timeout: 15000 }); },
  },
];

/** What is wrong with `now`, given the epoch it must carry and what the baseline had. Empty = fine. */
function problems(now, epoch, base) {
  const out = [];
  if (!now) return ["panel not rendered"];
  const stale = (list) => list.filter((e) => e !== epoch).length;
  if (now.imgs.length === 0 && base.imgs.length > 0) out.push("no visible picture");
  if (base.livePics.length > 0 && now.livePics.length === 0) out.push("live pictures lost their links");
  if (stale(now.livePics) > 0) out.push(`${stale(now.livePics)} live-picture links carry another epoch`);
  if (now.imgs.some((img) => img.epoch !== epoch)) out.push(`${now.imgs.filter((img) => img.epoch !== epoch).length}/${now.imgs.length} pictures carry another epoch (${[...new Set(now.imgs.map((i) => `e${i.epoch}`))].join(",")})`);
  if (now.imgs.some((img) => !img.ok)) out.push(`${now.imgs.filter((img) => !img.ok).length} pictures not loaded`);
  if (now.failed > 0) out.push(`${now.failed} pictures in the failed state`);
  if (base.rows.length > 0 && now.rows.length === 0) out.push("audio rows lost their links");
  if (stale(now.rows) > 0) out.push(`${stale(now.rows)} audio row links carry another epoch`);
  if (base.players.length > 0 && now.players.length === 0) out.push("audio player lost its link");
  if (stale(now.players) > 0) out.push(`${stale(now.players)} audio player links carry another epoch`);
  if (base.videos.length > 0 && now.videos.length === 0) out.push("video lost its link");
  if (stale(now.videos) > 0) out.push(`${stale(now.videos)} video links carry another epoch`);
  if (now.reconnecting) out.push("still says Reconnecting");
  return out;
}

/** Polls until `problems` is empty or `within` ms passed; returns { ms, left } (left = remaining problems, [] = recovered). */
async function recover(fx, epoch, base, within, nudge) {
  const started = Date.now();
  let now = null;
  let left = ["not looked at yet"];
  while (Date.now() - started <= within) {
    try { await nudge?.(); } catch { /* the page is between documents */ }
    now = await inspect(fx).catch(() => null);
    left = problems(now, epoch, base);
    if (left.length === 0) return { ms: Date.now() - started, left, now };
    await fx.settle(100);
  }
  const first = left;
  // Past the deadline: keep looking (up to 20 s) only to say in the report how late it was.
  let late = null;
  while (Date.now() - started <= 20000 && left.length > 0) {
    await fx.settle(500);
    now = await inspect(fx).catch(() => null);
    if (problems(now, epoch, base).length === 0) late = Date.now() - started;
    left = problems(now, epoch, base);
  }
  return { ms: Date.now() - started, left: [`${first.join("; ")}${late === null ? "; still wrong after 20 s" : `; recovered LATE after ${late} ms`}`], now };
}

await runSmoke("fixture-reconnect", async (fx) => {
  for (const state of STATES) {
    const id = state.id;
    await fx.open(state.path, { epoch: 0 });
    await state.prepare(fx);
    await fx.settle(1200); // pictures finish, the panel persists its copy
    const base = await inspect(fx);
    const basePast = problems(base, 0, base).filter((line) => !/another epoch|no visible/.test(line));
    await fx.check(`[${id}] (i) baseline: pictures loaded, nothing failed`, !!base && base.imgs.length > 0 && base.imgs.every((img) => img.ok && img.epoch === 0) && base.failed === 0 && basePast.length === 0, base ? `${base.imgs.length} pictures, ${base.rows.length} audio links, ${base.players.length} players, ${base.videos.length} videos${basePast.length ? `; ${basePast.join("; ")}` : ""}` : "no panel");
    if (id.startsWith("wildlife")) await fx.check(`[${id}] (i) audio rows have a link`, base.rows.length > 0, `${base.rows.length} rows`);
    if (id === "heard visit") await fx.check(`[${id}] (i) audio player has a link`, base.players.length > 0, `${base.players.length}`);
    if (id === "seen visit" && base.videos.length === 0) fx.skip(`[${id}] (i) the <video> has a link`, "this page renders no <video> with a media link before it is played");
    const storage = await fx.page.evaluate(() => Object.fromEntries(Object.entries(localStorage)));
    const old401Before = fx.media.old401;

    // (ii) the outage
    const restart = fx.page.evaluate((downMs) => window.__ha.restart({ downMs }), DOWN_MS);
    await fx.settle(700);
    const out = await inspect(fx);
    const outageOk = !!out && out.stateKinds.every((kind) => !/error|loading|stale/.test(kind)) && out.tiles >= base.tiles && out.cameras >= base.cameras && out.rows.length >= base.rows.length && out.imgs.length >= Math.min(1, base.imgs.length);
    await fx.check(`[${id}] (ii) outage: last data stays, no blank or error screen`, outageOk, out ? `states [${out.stateKinds.join(",")}], tiles ${out.tiles}/${base.tiles}, cameras ${out.cameras}/${base.cameras}, rows ${out.rows.length}/${base.rows.length}, pictures ${out.imgs.length}` : "no panel");
    await fx.check(`[${id}] (ii) outage: a quiet 'Reconnecting' strip shows`, !!out?.reconnecting);
    if (fx.width >= 800 || id.startsWith("wildlife")) await fx.shot(`${id.replace(/\W+/g, "-")}-outage`);
    await restart;

    // (iii) after the reconnect
    const epoch = fx.epoch;
    const result = await recover(fx, epoch, base, RECOVER_MS);
    await fx.check(`[${id}] (iii) within ${RECOVER_MS / 1000} s everything carries e${epoch}, is loaded, strip gone`, result.left.length === 0, result.left.length ? result.left.join("; ") : `recovered after ${result.ms} ms (${result.now.imgs.length} pictures, ${result.now.rows.length} rows)`);
    await fx.settle(600);
    const entry = fx.media.perEpoch.get(epoch);
    await fx.check(`[${id}] (iii) no request with e${epoch} got a 401`, (entry?.s401 ?? 0) === 0, `e${epoch}: ${entry?.requests ?? 0} requests, ${entry?.s401 ?? 0} x 401`);
    const old401After = fx.media.old401 - old401Before;

    // (iv) reload with the old persisted copy
    await fx.page.evaluate((saved) => { localStorage.clear(); for (const [key, value] of Object.entries(saved)) localStorage.setItem(key, value); }, storage);
    const old401Reload = fx.media.old401;
    await fx.page.reload({ waitUntil: "domcontentloaded" });
    await fx.waitForPanel();
    await fx.poll(async () => { await state_show(fx, state); return true; }, { timeout: 3000 });
    const reloaded = await recover(fx, epoch, base, RECOVER_MS, () => state_show(fx, state));
    await fx.check(`[${id}] (iv) reload with the old copy: within ${RECOVER_MS / 1000} s everything carries e${epoch} and is loaded`, reloaded.left.length === 0, reloaded.left.length ? reloaded.left.join("; ") : `recovered after ${reloaded.ms} ms`);
    await fx.settle(600);
    const entry2 = fx.media.perEpoch.get(epoch);
    await fx.check(`[${id}] (iv) no request with e${epoch} got a 401`, (entry2?.s401 ?? 0) === 0, `e${epoch}: ${entry2?.requests ?? 0} requests, ${entry2?.s401 ?? 0} x 401`);
    fx.info(`[${id}] old-epoch 401s: ${old401After} after the restart, ${fx.media.old401 - old401Reload} during the reload; ${fx.mediaSummary()}`);
  }

  // (v) The panel is RE-CREATED (Home Assistant switched to another panel and back) while the page lives on. First across a restart: links kept in the
  // page's module memory are dead, the new panel must notice and use fresh ones. Then without a restart: it must keep what it has.
  const SPECIES_ADDRESS = "/kestrel/wildlife?s=Northern%20Cardinal";
  const away = () => fx.page.evaluate(() => document.querySelector("ha-panel-custom").navigate("/lovelace/0"));
  const back = (path) => fx.page.evaluate((to) => document.querySelector("ha-panel-custom").navigate(to), path);
  const panelCount = () => fx.page.evaluate(() => window.__deep(document, "kestrel-panel").length);
  // The address already opens the sheet: wait for it and for its rows.
  const sheetFromAddress = async () => { await fx.poll(() => fx.panel.speciesOpen(), { timeout: 15000 }); await fx.poll(async () => ((await inspect(fx))?.rows.length ?? 0) > 0, { timeout: 10000 }); };
  await fx.open(SPECIES_ADDRESS, { epoch: 0 });
  await sheetFromAddress();
  await fx.settle(1200);
  const base5 = await inspect(fx);
  await fx.check("[re-created panel] (i) baseline: sheet open, pictures loaded, rows have links", !!base5 && base5.imgs.length > 0 && base5.imgs.every((img) => img.ok && img.epoch === 0) && base5.rows.length > 0, base5 ? `${base5.imgs.length} pictures, ${base5.rows.length} rows` : "no panel");
  await away();
  await fx.check("[re-created panel] (ii) leaving the address destroys the panel element", (await fx.poll(async () => (await panelCount()) === 0, { timeout: 3000 })) === true);
  await fx.page.evaluate(() => window.__ha.restart({ downMs: 1500 }));
  const restartedEpoch = fx.epoch;
  await back(SPECIES_ADDRESS);
  await fx.check("[re-created panel] (ii) coming back creates a new panel element", (await fx.poll(async () => (await panelCount()) === 1, { timeout: 5000 })) === true);
  const afterRestart = await recover(fx, restartedEpoch, base5, 6000);
  await fx.check(`[re-created panel] (iii) after a restart: within 6 s hero, tiles, rail and rows carry e${restartedEpoch} and are loaded`, afterRestart.left.length === 0, afterRestart.left.length ? afterRestart.left.join("; ") : `recovered after ${afterRestart.ms} ms (${afterRestart.now.imgs.length} pictures, ${afterRestart.now.rows.length} rows)`);
  await fx.settle(600);
  const entry5 = fx.media.perEpoch.get(restartedEpoch);
  await fx.check(`[re-created panel] (iii) no request with e${restartedEpoch} got a 401`, (entry5?.s401 ?? 0) === 0, `e${restartedEpoch}: ${entry5?.requests ?? 0} requests, ${entry5?.s401 ?? 0} x 401`);
  fx.info(`[re-created panel] ${fx.mediaSummary()}`);

  // no restart: a re-created panel keeps its links and does not reload pictures
  await fx.open(SPECIES_ADDRESS, { epoch: 0 });
  await sheetFromAddress();
  await fx.settle(1500);
  const before6 = await inspect(fx);
  const requests0 = [...fx.media.perEpoch.values()].reduce((sum, e) => sum + e.requests, 0);
  const calls0 = await fx.page.evaluate(() => window.__ha.calls.length);
  await away();
  await fx.poll(async () => (await panelCount()) === 0, { timeout: 3000 });
  await back(SPECIES_ADDRESS);
  await fx.poll(async () => (await panelCount()) === 1, { timeout: 5000 });
  await fx.poll(async () => ((await inspect(fx))?.imgs.length ?? 0) > 0, { timeout: 6000 });
  await fx.settle(2500);
  const after6 = await inspect(fx);
  const requests1 = [...fx.media.perEpoch.values()].reduce((sum, e) => sum + e.requests, 0);
  const calls1 = await fx.page.evaluate(() => window.__ha.calls.map((call) => call.type));
  const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  await fx.check("[re-created panel] (iv) without a restart: same links kept (nothing thrown away)", !!after6 && same(before6.imgUrls, after6.imgUrls) && same(before6.rowUrls, after6.rowUrls), after6 ? `${after6.imgUrls.length} pictures, ${after6.rowUrls.length} rows` : "no panel");
  await fx.check("[re-created panel] (iv) without a restart: at most 3 media requests for the new panel (the one link probe, no reloads)", requests1 - requests0 <= 3, `${requests1 - requests0} media requests`);
  fx.info(`[re-created panel] without restart: ${requests1 - requests0} media requests, ${calls1.length - calls0} websocket calls (${calls1.slice(calls0).join(", ") || "none"})`);

  // The interceptor itself: a link of the last epoch answers, one of an earlier epoch is refused.
  const panelOld401 = fx.media.old401;
  const unsignedFromPanel = fx.media.log.filter((entry) => entry.epoch === -1);
  await fx.page.evaluate(() => window.__ha.restart({ downMs: 100 })); // make sure there is an older epoch to refuse
  const [stale, fresh] = await fx.page.evaluate(async (epoch) => [(await fetch(`/api/kestrel/media/live/106?authSig=e${epoch - 1}`)).status, (await fetch(`/api/kestrel/media/live/106?authSig=e${epoch}`)).status], fx.epoch);
  await fx.check("interceptor: old-epoch link -> 401, current-epoch link -> 200", stale === 401 && fresh === 200, `old ${stale}, new ${fresh}`);
  const unsigned = unsignedFromPanel;
  await fx.check("every media request carried an authSig (no unsigned link)", unsigned.length === 0, unsigned.length ? unsigned.map((entry) => `${entry.path} -> ${entry.status}`).join("; ") : "all signed");
  fx.info(`the panel itself made ${panelOld401} request(s) with an old-epoch link, all answered 401 by the interceptor; ${fx.mediaSummary()}`);
}, { watchdogSeconds: 420 });
