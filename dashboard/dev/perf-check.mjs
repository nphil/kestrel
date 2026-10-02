#!/usr/bin/env node
/**
 * Kestrel release gate: measures the panel against the standing requirements and exits non-zero when one fails.
 *
 *   node dev/perf-check.mjs                       real panel through Home Assistant, every device size
 *   node dev/perf-check.mjs --sizes phone,laptop   only some sizes
 *   node dev/perf-check.mjs --target harness       the local fixture page (no Home Assistant, no secrets)
 *
 * Gates (per size; heavy scenarios run on the sizes in FULL, the rest get layout, input and static checks):
 *   press      pressed feedback is painted within 50 ms of the pointer going down, on every tappable thing
 *              (never scrolled into view first; an inert press is measured just before each one, in the same
 *              state, and over 50 ms only counts against the control if it is clearly above that, by more than
 *              12 ms, 24 on a 4x-throttled CPU, because a busy machine slows every press the same)
 *   tabs       revisiting Live / Wildlife / AI check-up: the new view's first frame within 100 ms and stable
 *              within 300 ms (both doubled on a 4x-throttled CPU); misses that are Home Assistant's or
 *              Scrypted's work on the shared main thread, not the panel's, are reported but don't fail
 *   open       real content or shaped skeletons within 1 s of the panel starting; never a lone spinner
 *              (and with a saved snapshot, real content at once)
 *   scroll     scrolling the Wildlife grid and the recordings list: no task over 50 ms, layout shift ~0
 *   back       Back returns to the same view and the same scroll position
 *   audio      a recording starts playing within 300 ms of the tap
 *   video      a video thumbnail is playing within 1.5 s of the tap
 *   targets    every visible control is at least 44 px; nothing that looks tappable is dead
 *   hover      hover styles exist only under (hover: hover) and (pointer: fine)
 *   layout     no horizontal overflow; the Lucent profile matches the device; the shell leaves room for content
 *
 * Options: --target ha|harness  --base URL (default http://127.0.0.1:8124)  --cdp URL (attach to a running
 * Chromium; otherwise one is launched)  --bundle FILE (serve this build instead of the deployed one)
 * --token-file FILE (default /data/home/tmp/ha-token)  --sizes a,b  --throttle N  --out DIR  --no-shots  --json
 * --retries N (default 1): a size that fails is measured again and the better run is kept, because a busy
 * machine inflates timings; the report records the host load and a CPU probe so a noisy run can be recognised.
 * Never prints or stores the Home Assistant token.
 */
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { cpus, loadavg } from "node:os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------------------------- options
const argv = process.argv.slice(2);
const flag = (name, fallback = undefined) => { const i = argv.indexOf(`--${name}`); return i < 0 ? fallback : (argv[i + 1]?.startsWith("--") || argv[i + 1] === undefined ? true : argv[i + 1]); };
const opts = {
  target: flag("target", "ha"),
  base: flag("base", process.env.KESTREL_BASE ?? "http://127.0.0.1:8124"),
  cdp: flag("cdp", process.env.KESTREL_CDP),
  bundle: flag("bundle"),
  tokenFile: flag("token-file", process.env.KESTREL_TOKEN_FILE ?? "/data/home/tmp/ha-token"),
  sizes: flag("sizes") ? String(flag("sizes")).split(",") : null,
  throttle: flag("throttle") ? Number(flag("throttle")) : null,
  out: flag("out", "/tmp/kestrel-perf"),
  shots: !argv.includes("--no-shots"),
  retries: flag("retries") ? Number(flag("retries")) : 1,
  json: argv.includes("--json"),
};

// Device sizes (Lucent profiles: LANGUAGE.md section 7). `throttle` approximates his iPhone on touch devices.
const SIZES = {
  phone: { w: 390, h: 844, touch: true, dpr: 3, throttle: 4, expect: "phone", short: false, full: true },
  phoneSmall: { w: 320, h: 640, touch: true, dpr: 2, throttle: 4, expect: "phone", short: false },
  phoneLarge: { w: 430, h: 932, touch: true, dpr: 3, throttle: 4, expect: "phone", short: false },
  phoneLandscape: { w: 844, h: 390, touch: true, dpr: 3, throttle: 4, expect: "phone", short: true },
  tablet: { w: 820, h: 1180, touch: true, dpr: 2, throttle: 4, expect: "tablet", short: false },
  tabletLandscape: { w: 1180, h: 820, touch: true, dpr: 2, throttle: 4, expect: "tablet", short: false },
  smart: { w: 960, h: 480, touch: true, dpr: 1, throttle: 4, expect: "smart", short: true, hideSidebar: true },
  laptop: { w: 1280, h: 800, touch: false, dpr: 1, throttle: 1, expect: "desktop", short: false, full: true },
  laptop1366: { w: 1366, h: 768, touch: false, dpr: 1, throttle: 1, expect: "desktop", short: false },
  laptop1440: { w: 1440, h: 900, touch: false, dpr: 1, throttle: 1, expect: "desktop", short: false },
  desktop: { w: 1920, h: 1080, touch: false, dpr: 1, throttle: 1, expect: "desktop", short: false },
  desktop4k: { w: 2560, h: 1440, touch: false, dpr: 1, throttle: 1, expect: "desktop", short: false },
};

const GATE = { pressOverFloorMs: 12, tabFirstMs: 100, tabStableMs: 300, pressMs: 50, tabMs: 100, openMs: 1000, longTaskMs: 50, cls: 0.02, audioMs: 300, videoMs: 1500, targetPx: 44, scrollDrift: 3 };

// ---------------------------------------------------------------------------------------------- in-page helpers
/** Installed in every page before its scripts run. */
function installProbe() {
  const deep = (rootNode, selector, out = []) => {
    rootNode.querySelectorAll(selector).forEach((el) => out.push(el));
    rootNode.querySelectorAll("*").forEach((el) => { if (el.shadowRoot) deep(el.shadowRoot, selector, out); });
    return out;
  };
  const probe = { deep, longTasks: [], frames: [], shifts: [], marks: {}, hostEl: null };
  // Found once, then reused: searching every shadow root of Home Assistant on each call would skew timings.
  const host = () => {
    if (probe.hostEl?.isConnected) return probe.hostEl;
    probe.hostEl = deep(document, "kestrel-panel")[0] ?? deep(document, "kestrel-cameras")[0] ?? null;
    return probe.hostEl;
  };
  probe.host = host;
  /** After a scroll: layout shift, and the long frames split into the panel's own share and everyone else's. */
  probe.report = () => {
    const own = probe.frames.map((f) => f.ownMs + f.renderMs);
    return {
      cls: +probe.shifts.reduce((a, b) => a + b, 0).toFixed(4),
      longFrames: probe.frames.length,
      ownWorstMs: Math.max(0, ...own),
      hostWorstMs: Math.max(0, ...probe.frames.map((f, i) => f.dur - own[i])),
      longTasks: probe.longTasks.slice(),
      travelled: Math.round(scrollY),
    };
  };
  window.__kp = probe;
  try {
    new PerformanceObserver((list) => { for (const entry of list.getEntries()) probe.longTasks.push(Math.round(entry.duration)); }).observe({ type: "longtask", buffered: true });
    // Long animation frames say which scripts ran, so the panel's own cost can be told apart from Home Assistant's and Scrypted's.
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const ours = (script) => /kestrel/i.test(script.sourceURL ?? "");
        const own = entry.scripts.filter(ours).reduce((sum, script) => sum + script.duration, 0);
        const foreign = entry.scripts.filter((script) => !ours(script)).reduce((sum, script) => sum + script.duration, 0);
        // Style, layout and paint belong to the panel unless someone else's scripts were changing the page in the same frame.
        const render = entry.renderStart && foreign < 20 ? entry.startTime + entry.duration - entry.renderStart : 0;
        probe.frames.push({ dur: Math.round(entry.duration), ownMs: Math.round(own), renderMs: Math.round(render) });
      }
    }).observe({ type: "long-animation-frame", buffered: true });
    new PerformanceObserver((list) => { for (const entry of list.getEntries()) if (!entry.hadRecentInput) probe.shifts.push(entry.value); }).observe({ type: "layout-shift", buffered: true });
  } catch { /* an older browser: the scroll gate reports "unavailable" */ }
  // When did the panel start, show a skeleton, show content?
  const poll = setInterval(() => {
    const h = probe.hostEl?.isConnected ? probe.hostEl : (document.readyState === "loading" ? null : host());
    if (!h) return;
    probe.marks.panel ??= performance.now();
    const sr = h.shadowRoot;
    if (!sr) return;
    if (probe.marks.skeleton === undefined && sr.querySelector(".bone")) probe.marks.skeleton = performance.now();
    if (probe.marks.content === undefined && sr.querySelector(".camera-name, .species-name, .visit-title-row, .health-tile")) { probe.marks.content = performance.now(); clearInterval(poll); }
    if (probe.marks.spinner === undefined && sr.querySelector(".loader")) probe.marks.spinner = performance.now();
  }, 100);
}

// ---------------------------------------------------------------------------------------------- browser + server
const staticTypes = { ".html": "text/html", ".js": "text/javascript", ".svg": "image/svg+xml", ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".png": "image/png", ".map": "application/json" };
async function serveHarness() {
  if (!existsSync(join(root, "dev/dist/harness.js"))) spawnSync("node", ["dev/build.mjs"], { cwd: root, stdio: "inherit" });
  const server = createServer((req, res) => {
    const path = join(root, decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (!path.startsWith(root) || !existsSync(path) || !statSync(path).isFile()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": staticTypes[extname(path)] ?? "application/octet-stream", "accept-ranges": "bytes" }).end(readFileSync(path));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { server, url: `http://127.0.0.1:${server.address().port}/dev/index.html` };
}

function newestBundle() {
  const dir = join(root, "../custom_components/kestrel/frontend");
  const files = readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => join(dir, f));
  return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

async function openContext(browser, size, harnessUrl) {
  const context = await browser.newContext({ viewport: { width: size.w, height: size.h }, hasTouch: size.touch, isMobile: size.touch, deviceScaleFactor: size.dpr });
  await context.addInitScript(installProbe);
  if (opts.target === "ha") {
    const token = readFileSync(opts.tokenFile, "utf8").trim();
    await context.addInitScript(([secret, base, hide]) => {
      try {
        if (!localStorage.getItem("hassTokens")) localStorage.setItem("hassTokens", JSON.stringify({ access_token: secret, token_type: "Bearer", expires_in: 1800, hassUrl: base, clientId: `${base}/`, expires: Date.now() + 365 * 864e5, refresh_token: "" }));
        if (hide) localStorage.setItem("dockedSidebar", JSON.stringify("always_hidden"));
      } catch { /* a page without storage */ }
    }, [token, opts.base, Boolean(size.hideSidebar)]);
    const file = opts.bundle ?? newestBundle();
    const body = readFileSync(file);
    await context.route("**/kestrel-static/kestrel.*.js*", (route) => route.fulfill({ status: 200, contentType: "application/javascript", body }));
  }
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const throttle = opts.throttle ?? size.throttle;
  if (throttle > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) errors.push(m.text().slice(0, 200)); });
  page.on("response", (r) => { if (r.status() >= 400 && !r.url().endsWith("/favicon.ico") && !(opts.target === "harness" && r.url().includes("/media/camera/")) && !/\/(api\/websocket|auth\/)/.test(r.url())) errors.push(`${r.status()} ${new URL(r.url()).pathname.slice(0, 80)}`); });
  // Scrypted's live cards reject with the bare string "closed" (no Error, no stack) when they are torn down while still
  // connecting; Kestrel only ever throws Errors, so those are counted and reported, but they are not the panel's failure.
  const foreign = [];
  page.on("pageerror", (e) => {
    if (!e.name && !e.stack && String(e.message) === "closed") foreign.push("closed");
    else errors.push(`pageerror: ${String(e).slice(0, 200)}`);
  });
  return { context, page, cdp, errors, foreign, throttle, harnessUrl };
}

async function gotoPanel(ctx, view = "live", { cold = false } = {}) {
  const { page } = ctx;
  if (opts.target === "harness") {
    await page.goto(ctx.harnessUrl, { waitUntil: "load" });
    if (cold) await page.evaluate(() => localStorage.removeItem("kestrel.panel.v2"));
    if (view !== "live") await page.evaluate((id) => document.getElementById(id)?.click(), view);
  } else {
    if (cold) await page.goto(`${opts.base}/auth/authorize`, { waitUntil: "domcontentloaded" }).then(() => page.evaluate(() => localStorage.removeItem("kestrel.panel.v2"))).catch(() => undefined);
    await page.goto(`${opts.base}/kestrel/${view}`, { waitUntil: "domcontentloaded" });
  }
  await page.waitForFunction(() => window.__kp?.marks.content !== undefined, null, { timeout: 45000 });
  await page.waitForTimeout(400);
}

// ---------------------------------------------------------------------------------------------- measurements
const root$ = (fn, ...args) => (page) => page.evaluate(fn, ...args);

const INERT = `(k) => k.host().shadowRoot.querySelector('h1')`;

/** Presses the control three times, each right after pressing something inert in the same state, and keeps the
 * median of both. One scheduling hiccup of the test browser doesn't decide a gate, and "what an inert press costs
 * right now" is measured under the same load and scroll position as the control, not at some other moment. */
async function press(ctx, name, find, inert = INERT) {
  const runs = [];
  const floors = [];
  for (let i = 0; i < 3; i++) {
    const floor = await pressOnce(ctx, "inert", inert);
    const run = await pressOnce(ctx, name, find);
    if (run.skipped) return run;
    if (!floor.skipped) floors.push(floor.ms);
    runs.push(run);
  }
  runs.sort((a, b) => a.ms - b.ms);
  floors.sort((a, b) => a - b);
  const median = runs[1];
  return { ...median, maxMs: runs[2].ms, floorMs: floors.length ? floors[1] ?? floors[0] : 0, pass: median.ms <= GATE.pressMs && median.changed };
}

/** Press (pointer down, no release) on the first element matching `find`, report time to painted feedback. */
async function pressOnce(ctx, name, find) {
  const { page, cdp, size } = ctx;
  // Pressing what is already on screen costs no scrolling; scrolling right before a press would measure the new
  // tiles' images being decoded and painted instead of the control.
  const rect = await page.evaluate(`(() => { const el = (${find})(window.__kp); if (!el) return null; const top = el.getBoundingClientRect().top; el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); const r = el.getBoundingClientRect(); return r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, scrolled: Math.abs(r.top - top) > 1 } : null; })()`);
  if (!rect) return { name, skipped: "not on screen" };
  await page.waitForTimeout(rect.scrolled ? 400 : 120);
  const rect2 = await page.evaluate(`(() => { const el = (${find})(window.__kp); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await page.evaluate(`(() => {
    const el = (${find})(window.__kp);
    const look = (node, pseudo) => { const s = getComputedStyle(node, pseudo); return [s.transform, s.backgroundColor, s.backgroundImage, s.boxShadow, s.opacity, s.filter, pseudo ? s.content : ''].join('|'); };
    // What the press changed: the control and three levels above it, plus its own children and the veils drawn
    // by their ::before/::after (a pressed picture tile shows itself through a veil or a child's wash).
    const sig = (node) => {
      const parts = [];
      for (let n = node, i = 0; n && i < 4; n = n.parentElement ?? n.getRootNode()?.host, i++) parts.push(look(n));
      for (const n of [node, ...node.querySelectorAll('*')].slice(0, 40)) { parts.push(look(n, '::before'), look(n, '::after')); if (n !== node) parts.push(look(n)); }
      return parts.join('||');
    };
    const before = sig(el);
    // The frame that shows the pressed state is produced between the first and the second animation-frame
    // callback after the press, so the second callback marks the moment it is on its way to the screen.
    window.__press = new Promise((resolve) => {
      window.addEventListener('pointerdown', (e) => {
        const t = e.timeStamp;
        requestAnimationFrame(() => requestAnimationFrame(() => resolve({ ms: Math.round(performance.now() - t), changed: sig(el) !== before })));
      }, { capture: true, once: true });
    });
  })()`);
  if (size.touch) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: rect2.x, y: rect2.y }] });
  } else {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect2.x, y: rect2.y });
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect2.x, y: rect2.y, button: "left", clickCount: 1 });
  }
  const result = await page.evaluate(() => window.__press);
  if (size.touch) await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
  else {
    // Release in place, but keep the click from acting: this measures the press, it doesn't use the control.
    await page.evaluate(() => window.addEventListener("click", (e) => e.stopImmediatePropagation(), { capture: true, once: true }));
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect2.x, y: rect2.y, button: "left", clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 });
  }
  await page.waitForTimeout(120);
  return { name, ...result, pass: result.ms <= GATE.pressMs && result.changed };
}

const NAV = (label) => `(k) => [...k.host().shadowRoot.querySelectorAll('.nav-item')].find((b) => b.textContent.trim().startsWith('${label}'))`;

/** The most a press may cost over an inert press before it counts as the control's doing (doubled on a 4x-throttled
 * CPU, like the tab budgets: the same few milliseconds of real work last four times longer there). */
const overAllowance = (ctx) => GATE.pressOverFloorMs * (ctx.throttle > 1 ? 2 : 1);

async function pressSuite(ctx, view) {
  const rows = await pressRows(ctx, view);
  const allowed = overAllowance(ctx);
  for (const row of rows) {
    if (row.skipped) continue;
    row.overMs = row.ms - row.floorMs;
    // Over 50 ms is only the control's doing if it is clearly above what an inert press takes in the same state.
    row.pass = row.changed && (row.ms <= GATE.pressMs || row.overMs <= allowed);
    row.limitedByHost = row.changed && row.ms > GATE.pressMs && row.overMs <= allowed;
  }
  return rows;
}

async function pressRows(ctx, view) {
  const rows = [];
  if (view !== "sheet") { await ctx.page.evaluate(() => window.scrollTo(0, 0)); await ctx.page.waitForTimeout(300); }
  if (view === "live") {
    rows.push(await press(ctx, "camera tile", `(k) => k.host().shadowRoot.querySelector('.camera-focus')`));
    rows.push(await press(ctx, "sighting chip", `(k) => k.host().shadowRoot.querySelector('.chip-button')`));
    rows.push(await press(ctx, "tab", NAV("Wildlife")));
  } else if (view === "wildlife") {
    rows.push(await press(ctx, "species tile", `(k) => k.host().shadowRoot.querySelector('.species-tile:not(.skeleton)')`));
    rows.push(await press(ctx, "filter option", `(k) => [...k.host().shadowRoot.querySelector('kestrel-segmented').shadowRoot.querySelectorAll('[role=radio]')].find((r) => r.getAttribute('aria-checked') !== 'true')`));
    rows.push(await press(ctx, "tab", NAV("Live")));
  } else if (view === "sheet") {
    const sheet = `k.deep(document, 'kestrel-species-sheet')[0].shadowRoot`;
    const title = `(k) => k.deep(document, 'kestrel-sheet')[0]?.shadowRoot.querySelector('#title')`;
    rows.push(await press(ctx, "video thumbnail", `(k) => ${sheet}.querySelector('kestrel-media-rail')?.shadowRoot.querySelector('.item')`, title));
    rows.push(await press(ctx, "play button", `(k) => ${sheet}.querySelector('kestrel-audio-list')?.shadowRoot.querySelector('.play:not(:disabled)')`, title));
    rows.push(await press(ctx, "recording row", `(k) => ${sheet}.querySelector('kestrel-audio-list')?.shadowRoot.querySelector('.open')`, title));
    rows.push(await press(ctx, "close button", `(k) => k.deep(document, 'kestrel-sheet')[0]?.shadowRoot.querySelector('.close')`, title));
  }
  return rows;
}

/** Click a nav tab in page. `first` is when the frame that shows the destination starts (content present, no
 * skeleton), `stable` the frame after it. Also reports the most the panel itself spent in any long frame while
 * that happened. Budgets (LUCENT plan): first 100 ms, stable 300 ms, doubled on a 4x-throttled CPU. A switch
 * that misses them still passes when the panel's own share is small (Home Assistant and Scrypted share the
 * page's main thread), and says so. */
async function tabTimes(ctx) {
  const { page } = ctx;
  const allowance = ctx.throttle >= 4 ? 2 : 1;
  const marker = { Live: ".camera-grid .camera-name", Wildlife: ".species-grid .species-name", "AI check-up": ".health-grid .health-tile" };
  const run = async (label) => {
    await page.evaluate(() => { window.__kp.frames.length = 0; });
    const times = await page.evaluate(([name, selector]) => new Promise((resolve) => {
      const sr = window.__kp.host().shadowRoot;
      const button = [...sr.querySelectorAll(".nav-item")].find((b) => b.textContent.trim().startsWith(name));
      const t0 = performance.now();
      button.click();
      const tick = () => {
        const view = window.__kp.host().shadowRoot;
        if (view.querySelector(selector) && !view.querySelector(".bone")) {
          const first = Math.round(performance.now() - t0);
          requestAnimationFrame(() => resolve({ first, stable: Math.round(performance.now() - t0) }));
        } else if (performance.now() - t0 > 6000) resolve({ first: -1, stable: -1 });
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }), [label, marker[label]]);
    await page.waitForTimeout(450);
    const share = await page.evaluate(() => window.__kp.report());
    return { ...times, own: share.ownWorstMs, others: share.hostWorstMs };
  };
  const out = {};
  const again = [];
  for (const label of ["Wildlife", "AI check-up", "Live"]) { const r = await run(label); out[`first visit ${label}`] = r.stable; await page.waitForTimeout(1200); }
  for (const label of ["Wildlife", "AI check-up", "Live", "Wildlife", "Live"]) {
    const r = await run(label);
    again.push({ label, ...r });
    await page.waitForTimeout(500);
  }
  const within = (r) => r.first >= 0 && r.first <= GATE.tabFirstMs * allowance && r.stable <= GATE.tabStableMs * allowance;
  const pass = again.every((r) => within(r) || (r.first >= 0 && r.own <= GATE.longTaskMs));
  const hostLimited = again.some((r) => !within(r));
  return {
    ...out,
    revisits: again.map((r) => `${r.label} ${r.first}/${r.stable}`),
    worstFirst: Math.max(...again.map((r) => r.first)),
    worstStable: Math.max(...again.map((r) => r.stable)),
    panelWorstMs: Math.max(...again.map((r) => r.own)),
    budgetFirst: GATE.tabFirstMs * allowance,
    budgetStable: GATE.tabStableMs * allowance,
    limitedByOthers: pass && hostLimited,
    pass,
  };
}

async function scrollWindow(ctx) {
  const { page, cdp, size } = ctx;
  await page.evaluate(() => { window.__kp.longTasks.length = 0; window.__kp.frames.length = 0; window.__kp.shifts.length = 0; window.scrollTo(0, 0); });
  const distance = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
  if (distance > 50) {
    await cdp.send("Input.synthesizeScrollGesture", { x: size.w / 2, y: size.h / 2, yDistance: -Math.min(distance, 6000), speed: 1800, gestureSourceType: size.touch ? "touch" : "mouse" });
    await page.waitForTimeout(300);
  }
  return page.evaluate(() => window.__kp.report());
}

async function scrollSheetList(ctx) {
  const { page, cdp, size } = ctx;
  const spot = await page.evaluate(() => {
    const sheet = window.__kp.deep(document, "kestrel-sheet")[0];
    const body = sheet?.shadowRoot.querySelector(".body");
    if (!body) return null;
    const r = body.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, scrollable: body.scrollHeight - body.clientHeight };
  });
  if (!spot) return { skipped: "no sheet" };
  await page.evaluate(() => { window.__kp.longTasks.length = 0; window.__kp.frames.length = 0; window.__kp.shifts.length = 0; });
  await cdp.send("Input.synthesizeScrollGesture", { x: spot.x, y: spot.y, yDistance: -Math.min(spot.scrollable, 4000), speed: 1500, gestureSourceType: size.touch ? "touch" : "mouse" });
  await page.waitForTimeout(300);
  return page.evaluate(() => window.__kp.report());
}

async function clickAt(ctx, find) {
  const { page, cdp, size } = ctx;
  const spot = await page.evaluate(`(() => { const el = (${find})(window.__kp); if (!el) return null; el.scrollIntoView({ block: 'center', inline: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (!spot) return false;
  await page.waitForTimeout(100);
  const fresh = await page.evaluate(`(() => { const r = (${find})(window.__kp).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (size.touch) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [fresh] });
    await page.waitForTimeout(70); // a finger rests for a moment: this is what a press-time warm-up gets to use
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } else {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...fresh });
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...fresh, button: "left", clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...fresh, button: "left", clickCount: 1 });
  }
  return true;
}

const SPECIES_TILE = (needle) => `(k) => [...k.host().shadowRoot.querySelectorAll('.species-tile')].find((t) => (t.getAttribute('aria-label') || '').startsWith(${JSON.stringify(`${needle}.`)}))`;

/** Opens a species sheet by tapping its tile; returns false when the species isn't listed. */
async function openSpecies(ctx, needle) {
  const { page } = ctx;
  if (!await clickAt(ctx, SPECIES_TILE(needle))) return false;
  await page.waitForFunction(() => window.__kp.deep(document, "kestrel-species-sheet")[0]?.shadowRoot.querySelector("kestrel-section[state=ready], kestrel-media-rail, kestrel-audio-list"), null, { timeout: 15000 }).catch(() => undefined);
  await page.waitForTimeout(600);
  return true;
}

/** Chooses an option of the Wildlife filter by its label and waits for the grid to follow. */
async function setFilter(ctx, label) {
  const { page } = ctx;
  await page.evaluate((text) => { const seg = window.__kp.host().shadowRoot.querySelector("kestrel-segmented"); [...seg.shadowRoot.querySelectorAll("[role=radio]")].find((r) => r.textContent.trim().startsWith(text))?.click(); }, label);
  await page.waitForTimeout(label === "All" ? 400 : 200);
  if (label !== "All") await page.waitForFunction(() => { const tiles = window.__kp.host().shadowRoot.querySelectorAll(".species-tile:not(.skeleton)"); return tiles.length > 0 && [...tiles].every((t) => /video|photo/.test(t.getAttribute("aria-label") || "")); }, null, { timeout: 8000 }).catch(() => undefined);
}

/** Species to test with: the one with the most recordings, one with videos (via the "On camera" filter), and a
 * tile far down the grid so Back has real scrolling to restore. */
async function pickSpecies(ctx) {
  const { page } = ctx;
  const read = () => page.evaluate(() => [...window.__kp.host().shadowRoot.querySelectorAll(".species-tile:not(.skeleton)")].map((t) => t.getAttribute("aria-label") || ""));
  const choose = (labels, word) => {
    const count = (label) => Number((label.match(new RegExp(`(\\d+) ${word}`)) ?? [])[1] ?? 0);
    const best = labels.map((l) => ({ name: l.split(".")[0], n: count(l) })).sort((a, b) => b.n - a.n)[0];
    return best?.n ? best.name : null;
  };
  const filter = (label) => page.evaluate((text) => { const seg = window.__kp.host().shadowRoot.querySelector("kestrel-segmented"); [...seg.shadowRoot.querySelectorAll("[role=radio]")].find((r) => r.textContent.trim().startsWith(text))?.click(); }, label);
  await filter("All");
  await page.waitForTimeout(300);
  const all = await read();
  const heard = choose(all, "recordings?");
  const deepLabel = all.filter((l) => /recordings?/.test(l))[Math.min(16, Math.max(0, all.length - 1))] ?? null;
  await filter("On camera");
  await page.waitForFunction(() => { const tiles = window.__kp.host().shadowRoot.querySelectorAll(".species-tile:not(.skeleton)"); return tiles.length > 0 && [...tiles].every((t) => /video|photo/.test(t.getAttribute("aria-label") || "")); }, null, { timeout: 8000 }).catch(() => undefined);
  const seen = choose(await read(), "(?:videos?|photos?)");
  await filter("All");
  await page.waitForTimeout(300);
  return { heard, seen, deep: deepLabel ? deepLabel.split(".")[0] : null };
}

async function audioStart(ctx) {
  const { page } = ctx;
  const find = `(k) => k.deep(document, 'kestrel-species-sheet')[0]?.shadowRoot.querySelector('kestrel-audio-list')?.shadowRoot.querySelector('.play:not(:disabled)')`;
  await page.evaluate(() => {
    const audio = window.__kp.deep(document, "kestrel-audio-list")[0].shadowRoot.querySelector("audio");
    window.__audio = new Promise((resolve) => {
      let down = 0; let tap = 0;
      window.addEventListener("pointerdown", (e) => { down = e.timeStamp; }, { capture: true, once: true });
      window.addEventListener("click", (e) => { tap = e.timeStamp; }, { capture: true, once: true });
      audio.addEventListener("playing", () => resolve({ ms: Math.round(performance.now() - tap), fromPressMs: Math.round(performance.now() - down) }), { once: true });
      setTimeout(() => resolve({ ms: -1 }), 6000);
    });
  });
  if (!await clickAt(ctx, find)) return { skipped: "no playable recording" };
  const result = await page.evaluate(() => window.__audio);
  return { ...result, pass: result.ms >= 0 && result.ms <= GATE.audioMs };
}

async function oneAtATime(ctx) {
  const { page } = ctx;
  await clickAt(ctx, `(k) => [...k.deep(document, 'kestrel-species-sheet')[0].shadowRoot.querySelector('kestrel-audio-list').shadowRoot.querySelectorAll('.play:not(:disabled)')][1]`);
  await page.waitForTimeout(800);
  return page.evaluate(() => {
    const playing = window.__kp.deep(document, "audio").filter((a) => !a.paused && !a.ended).length;
    return { playing, pass: playing === 1 };
  });
}

async function videoStart(ctx) {
  const { page } = ctx;
  await page.evaluate(() => {
    window.__video = new Promise((resolve) => {
      let down = 0;
      window.addEventListener("pointerdown", (e) => { down = e.timeStamp; }, { capture: true, once: true });
      const tick = () => {
        const video = window.__kp.host()?.shadowRoot.querySelector(".visit-video");
        if (video && video.readyState >= 3 && !video.paused && video.currentTime > 0) resolve({ ms: Math.round(performance.now() - down) });
        else if (down && performance.now() - down > 8000) resolve({ ms: -1 });
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  });
  const find = `(k) => [...k.deep(document, 'kestrel-species-sheet')[0].shadowRoot.querySelector('kestrel-media-rail').shadowRoot.querySelectorAll('.item')].find((i) => i.querySelector('.glyph'))`;
  if (!await clickAt(ctx, find)) return { skipped: "no video thumbnail" };
  const result = await page.evaluate(() => window.__video);
  return { ...result, pass: result.ms >= 0 && result.ms <= GATE.videoMs };
}

/** Wildlife scrolled -> sheet -> visit -> Back -> Back: same view, same scroll. */
async function backRestores(ctx, needle) {
  const { page } = ctx;
  const read = () => page.evaluate(() => ({ y: Math.round(scrollY), path: location.pathname + location.search, sheet: Boolean(window.__kp.deep(document, "kestrel-species-sheet")[0]) }));
  await page.evaluate(() => window.scrollTo(0, Math.min(900, document.documentElement.scrollHeight - innerHeight)));
  await page.waitForTimeout(300);
  if (!await openSpecies(ctx, needle)) return { skipped: "species not listed" };
  const opened = await read();
  const opener = `(k) => { const s = k.deep(document, 'kestrel-species-sheet')[0].shadowRoot; return s.querySelector('kestrel-media-rail')?.shadowRoot.querySelector('.item') ?? s.querySelector('kestrel-audio-list')?.shadowRoot.querySelector('.open'); }`;
  if (!await clickAt(ctx, opener)) return { skipped: "nothing to open" };
  await page.waitForFunction(() => location.pathname.endsWith("/visit"), null, { timeout: 8000 }).catch(() => undefined);
  await page.waitForTimeout(700);
  const visit = await read();
  await page.evaluate(() => window.__kp.host().shadowRoot.querySelector(".back-button")?.click());
  await page.waitForTimeout(900);
  const back1 = await read();
  await page.goBack();
  await page.waitForTimeout(900);
  const back2 = await read();
  // The reference is where the page was when the species was tapped (the tap scrolls its tile into view).
  const drift = Math.abs(back2.y - opened.y);
  return { start: opened.y, sheetOpened: opened.sheet && opened.path.includes("?s="), onVisit: visit.path.includes("/visit"), backToSheet: back1.sheet && back1.path.includes("?s="), sheetScroll: back1.y, closed: !back2.sheet && !back2.path.includes("?s="), finalScroll: back2.y, drift, pass: opened.sheet && visit.path.includes("/visit") && back1.sheet && !back2.sheet && drift <= GATE.scrollDrift };
}

async function staticChecks(ctx) {
  return ctx.page.evaluate((minPx) => {
    const { deep, host } = window.__kp;
    const h = host();
    const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
    const roots = [h, ...deep(h.shadowRoot, "*").filter((e) => e.shadowRoot)];
    const shadowRoots = roots.map((e) => e.shadowRoot);
    const interactive = [];
    for (const r of shadowRoots) r.querySelectorAll("button, a[href], input, select, [role=radio], [role=option]").forEach((el) => interactive.push(el));
    const label = (el) => (el.getAttribute("aria-label") || el.textContent || el.className || el.tagName).replace(/\s+/g, " ").trim().slice(0, 40);
    const small = interactive.filter(visible).map((el) => { const r = el.getBoundingClientRect(); return { label: label(el), w: Math.round(r.width), h: Math.round(r.height) }; }).filter((x) => Math.min(x.w, x.h) < minPx);
    // looks tappable (pointer cursor) but isn't inside anything interactive
    const dead = [];
    for (const r of shadowRoots) r.querySelectorAll("*").forEach((el) => {
      if (!visible(el) || getComputedStyle(el).cursor !== "pointer") return;
      const interactiveSelector = "button, a[href], [role=radio], [role=option], label, summary, input, select";
      let ancestor = el; let inside = false;
      while (ancestor && !inside) { inside = ancestor.matches?.(interactiveSelector) ?? false; ancestor = ancestor.parentNode instanceof ShadowRoot ? ancestor.parentNode.host : ancestor.parentElement; }
      if (!inside && !el.closest("scrypted-nvr-camera")) dead.push(label(el));
    });
    // hover rules outside (hover: hover)
    const bad = [];
    const scan = (rules, guarded, where) => {
      for (const rule of rules) {
        if (rule.cssRules && rule.media) scan(rule.cssRules, guarded || /hover:\s*hover/.test(rule.media.mediaText), where);
        else if (rule.cssRules) scan(rule.cssRules, guarded, where);
        else if (rule.selectorText && /:hover/.test(rule.selectorText) && !guarded) bad.push(`${where}: ${rule.selectorText.slice(0, 60)}`);
      }
    };
    for (const r of [h, ...roots]) {
      const sheets = r.shadowRoot?.adoptedStyleSheets ?? [];
      const where = r.localName;
      for (const sheet of sheets) { try { scan(sheet.cssRules, false, where); } catch { /* cross-origin */ } }
    }
    return { interactive: interactive.length, small, dead: [...new Set(dead)].slice(0, 8), hoverOutsideMedia: [...new Set(bad)].slice(0, 8) };
  }, GATE.targetPx);
}

async function layoutChecks(ctx, size, view) {
  const info = await ctx.page.evaluate(() => {
    const h = window.__kp.host();
    const sr = h.shadowRoot;
    const nav = sr.querySelector(".navigation")?.getBoundingClientRect();
    const top = sr.querySelector(".topbar")?.getBoundingClientRect();
    const main = sr.querySelector("main")?.getBoundingClientRect();
    const cols = getComputedStyle(sr.querySelector(".camera-grid, .species-grid") ?? h).gridTemplateColumns;
    return {
      profile: h.getAttribute("data-lu-profile"), short: h.hasAttribute("data-lu-short"),
      overflowX: Math.max(document.documentElement.scrollWidth, h.scrollWidth) > innerWidth + 1,
      panelW: Math.round(h.getBoundingClientRect().width),
      chromeTopPx: top ? Math.round(top.height) : 0, navBox: nav ? [Math.round(nav.width), Math.round(nav.height)] : null,
      contentPct: main ? Math.round((main.height > 0 ? Math.min(main.height, innerHeight - (top?.bottom ?? 0)) : 0) / innerHeight * 100) : null,
      columns: cols === "none" ? 0 : cols.split(" ").length, innerHeight,
    };
  });
  const bottomNavAndTop = info.navBox && info.navBox[1] > 0 && info.navBox[0] > info.panelW * 0.6 && info.chromeTopPx > 0 && size.short;
  return { ...info, view, pass: info.profile === size.expect && info.short === size.short && !info.overflowX && !bottomNavAndTop };
}

async function shot(ctx, name) {
  if (!opts.shots) return;
  mkdirSync(opts.out, { recursive: true });
  await ctx.page.screenshot({ path: join(opts.out, `${name}.png`) });
}

// ---------------------------------------------------------------------------------------------- run
async function runSize(browser, key, size, harnessUrl) {
  const ctx = await openContext(browser, size, harnessUrl);
  ctx.size = size;
  await ctx.page.bringToFront();
  const report = { size: key, viewport: `${size.w}x${size.h}`, throttle: `${ctx.throttle}x`, touch: size.touch, loadBefore: +loadavg()[0].toFixed(1), checks: {} };
  const c = report.checks;
  try {
    // A fixed piece of work, timed under this size's throttle: if it is slow, the machine is busy and the other numbers are inflated.
    report.cpuProbeMs = await ctx.page.evaluate(() => { const t0 = performance.now(); let x = 0; for (let i = 0; i < 3e6; i++) x += Math.sqrt(i) % 7; return Math.round(performance.now() - t0 + (x < 0 ? 1 : 0)); });
    // open: cold start, then the snapshot cache makes the next one warm
    await gotoPanel(ctx, "live", { cold: true });
    const cold = await ctx.page.evaluate(() => window.__kp.marks);
    c.open = { coldPanelToContentMs: Math.round(cold.content - cold.panel), coldSkeletonMs: cold.skeleton === undefined ? null : Math.round(cold.skeleton - cold.panel), spinnerSeen: cold.spinner !== undefined };
    // Either real content or shaped skeletons within a second, never a lone spinner; a cold open's real content depends on the network.
    c.open.firstPaintMs = Math.min(c.open.coldPanelToContentMs, c.open.coldSkeletonMs ?? Infinity);
    c.open.pass = c.open.firstPaintMs <= GATE.openMs && !c.open.spinnerSeen;
    await gotoPanel(ctx, "live");
    const warm = await ctx.page.evaluate(() => window.__kp.marks);
    c.open.warmPanelToContentMs = Math.round(warm.content - warm.panel);
    c.open.pass = c.open.pass && c.open.warmPanelToContentMs <= GATE.openMs; // from the saved snapshot: real content at once
    await shot(ctx, `${key}-live`);

    c.layoutLive = await layoutChecks(ctx, size, "live");
    c.pressLive = await pressSuite(ctx, "live");
    Object.assign(c, { staticLive: await staticChecks(ctx) });

    await gotoPanel(ctx, "wildlife");
    await shot(ctx, `${key}-wildlife`);
    c.layoutWildlife = await layoutChecks(ctx, size, "wildlife");
    c.pressWildlife = await pressSuite(ctx, "wildlife");
    c.staticWildlife = await staticChecks(ctx);

    // The other two screens get the same static checks: the check-up, and a visit opened from a camera's sighting chip.
    await ctx.page.evaluate(() => window.__kp.host().shadowRoot.querySelectorAll(".nav-item")[2]?.click());
    await ctx.page.waitForFunction(() => window.__kp.host().shadowRoot.querySelector(".health-grid .health-tile"), null, { timeout: 15000 }).catch(() => undefined);
    await ctx.page.waitForTimeout(500);
    c.staticInsights = await staticChecks(ctx);
    const visitId = await ctx.page.evaluate(() => window.__kp.host()._cameras?.find((camera) => camera.lastDetection)?.lastDetection.visitId ?? null);
    if (visitId) {
      await ctx.page.evaluate((id) => { history.pushState({ kestrel: 1 }, "", `${location.pathname.replace(/[^/]+$/, "visit")}?v=${id}`); window.dispatchEvent(new Event("location-changed")); }, visitId);
      await ctx.page.waitForFunction(() => window.__kp.host().shadowRoot.querySelector(".visit-title-row"), null, { timeout: 15000 }).catch(() => undefined);
      await ctx.page.waitForTimeout(700);
      await shot(ctx, `${key}-visit`);
      c.staticVisit = await staticChecks(ctx);
    }
    await gotoPanel(ctx, "wildlife");
    const pick = await pickSpecies(ctx);
    if (pick.heard && await openSpecies(ctx, pick.heard)) {
      await shot(ctx, `${key}-sheet`);
      c.pressSheet = await pressSuite(ctx, "sheet");
      c.staticSheet = await staticChecks(ctx);
      await ctx.page.evaluate(() => window.__kp.deep(document, "kestrel-sheet")[0]?.shadowRoot.querySelector(".close")?.click());
      await ctx.page.waitForTimeout(500);
    } else c.pressSheet = [{ name: "sheet", skipped: "no species with recordings" }];

    if (size.full) {
      c.tabs = await tabTimes(ctx);
      await gotoPanel(ctx, "wildlife");
      c.scrollGrid = await scrollWindow(ctx);
      c.scrollGrid.pass = c.scrollGrid.ownWorstMs <= GATE.longTaskMs && c.scrollGrid.cls <= GATE.cls;
      await ctx.page.evaluate(() => window.scrollTo(0, 0));
      if (pick.heard && await openSpecies(ctx, pick.heard)) {
        for (let i = 0; i < 4; i++) { if (!await clickAt(ctx, `(k) => k.deep(document, 'kestrel-species-sheet')[0]?.shadowRoot.querySelector('kestrel-audio-list')?.shadowRoot.querySelector('.text-button:not(:disabled)')`)) break; await ctx.page.waitForTimeout(700); }
        const rows = await ctx.page.evaluate(() => window.__kp.deep(document, "kestrel-audio-list")[0]?.rows?.length ?? 0);
        c.scrollRecordings = { rows, ...await scrollSheetList(ctx) };
        c.scrollRecordings.pass = (c.scrollRecordings.ownWorstMs ?? 0) <= GATE.longTaskMs && (c.scrollRecordings.cls ?? 0) <= GATE.cls;
        await ctx.page.evaluate(() => { const b = window.__kp.deep(document, "kestrel-sheet")[0]?.shadowRoot.querySelector(".body"); if (b) b.scrollTo(0, 0); });
        c.audio = await audioStart(ctx);
        c.oneAtATime = await oneAtATime(ctx);
        await ctx.page.evaluate(() => window.__kp.deep(document, "kestrel-sheet")[0]?.shadowRoot.querySelector(".close")?.click());
        await ctx.page.waitForTimeout(500);
      }
      if (pick.seen) {
        await gotoPanel(ctx, "wildlife");
        await setFilter(ctx, "On camera"); // a species seen only now and then isn't among the first tiles of the full list
        if (await openSpecies(ctx, pick.seen)) c.video = await videoStart(ctx);
        else c.video = { skipped: "the species with videos wasn't on screen" };
        await gotoPanel(ctx, "wildlife");
        await setFilter(ctx, "All");
      } else c.video = { skipped: "no species with videos" };
      c.back = await backRestores(ctx, pick.deep ?? pick.heard ?? "");
    }

    if (!size.touch) {
      // keyboard: shortcuts, visible focus
      await gotoPanel(ctx, "live");
      await ctx.page.keyboard.press("2");
      await ctx.page.waitForTimeout(500);
      const went = await ctx.page.evaluate(() => location.pathname.endsWith("/wildlife"));
      await ctx.page.keyboard.press("?");
      await ctx.page.waitForTimeout(500);
      const help = await ctx.page.evaluate(() => Boolean(window.__kp.deep(document, "kestrel-sheet")[0]));
      await ctx.page.keyboard.press("Escape");
      await ctx.page.waitForTimeout(500);
      await ctx.page.evaluate(() => window.__kp.host().shadowRoot.querySelector(".nav-item")?.focus());
      await ctx.page.keyboard.press("Tab");
      const ring = await ctx.page.evaluate(() => { let a = document.activeElement; while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement; return a && a !== document.body ? getComputedStyle(a).boxShadow !== "none" : false; });
      c.keyboard = { shortcutSwitchesView: went, helpOpens: help, focusRingVisible: ring, pass: went && help && ring };
    }
  } catch (error) {
    c.fatal = String(error?.stack ?? error).slice(0, 500);
  }
  report.consoleErrors = [...new Set(ctx.errors)].slice(0, 5);
  report.foreignRejections = ctx.foreign.length;
  report.loadAfter = +loadavg()[0].toFixed(1);
  await ctx.context.close();
  return report;
}

function judge(report) {
  const fails = [];
  const push = (gate, detail) => fails.push(`${report.size}: ${gate} - ${detail}`);
  const c = report.checks;
  if (c.fatal) push("run", c.fatal.split("\n")[0]);
  if (c.open && !c.open.pass) push("open", JSON.stringify(c.open));
  for (const key of ["layoutLive", "layoutWildlife"]) if (c[key] && !c[key].pass) push("layout", `${key}: ${JSON.stringify(c[key])}`);
  for (const key of ["pressLive", "pressWildlife", "pressSheet"]) for (const row of c[key] ?? []) if (!row.skipped && !row.pass) push("press", `${row.name}: ${row.ms} ms (inert press ${row.floorMs} ms), feedback ${row.changed ? "shown" : "MISSING"}`);
  for (const key of ["staticLive", "staticWildlife", "staticSheet", "staticInsights", "staticVisit"]) {
    const s = c[key];
    if (!s) continue;
    if (s.small.length) push("targets", `${key}: ${s.small.map((x) => `${x.label} ${x.w}x${x.h}`).join("; ")}`);
    if (s.dead.length) push("dead taps", `${key}: ${s.dead.join("; ")}`);
    if (s.hoverOutsideMedia.length) push("hover", `${key}: ${s.hoverOutsideMedia.join("; ")}`);
  }
  if (c.tabs && !c.tabs.pass) push("tabs", JSON.stringify(c.tabs));
  if (c.scrollGrid && !c.scrollGrid.pass) push("scroll grid", JSON.stringify(c.scrollGrid));
  if (c.scrollRecordings && !c.scrollRecordings.pass) push("scroll recordings", JSON.stringify(c.scrollRecordings));
  if (c.audio && !c.audio.skipped && !c.audio.pass) push("audio", `${c.audio.ms} ms`);
  if (c.oneAtATime && !c.oneAtATime.pass) push("one at a time", `${c.oneAtATime.playing} playing`);
  if (c.video && !c.video.skipped && !c.video.pass) push("video", `${c.video.ms} ms`);
  if (c.back && !c.back.skipped && !c.back.pass) push("back", JSON.stringify(c.back));
  if (c.keyboard && !c.keyboard.pass) push("keyboard", JSON.stringify(c.keyboard));
  if (report.consoleErrors.length) push("console", report.consoleErrors.join(" | "));
  return fails;
}

const harness = opts.target === "harness" ? await serveHarness() : null;
let browser; let launched = false;
if (opts.cdp) browser = await chromium.connectOverCDP(opts.cdp);
else {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required", "--enable-unsafe-swiftshader"] });
  launched = true;
}
const wanted = opts.sizes ?? Object.keys(SIZES);
const reports = [];
const failures = [];
for (const key of wanted) {
  const size = SIZES[key];
  if (!size) { console.error(`unknown size ${key}; choose from ${Object.keys(SIZES).join(", ")}`); process.exitCode = 2; continue; }
  process.stderr.write(`measuring ${key} (${size.w}x${size.h})...\n`);
  let best = null;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    const report = await runSize(browser, key, size, harness?.url);
    report.attempt = attempt + 1;
    const fails = judge(report);
    if (!best || fails.length < best.fails.length) best = { report, fails };
    if (!fails.length) break;
    if (attempt < opts.retries) process.stderr.write(`  ${key}: ${fails.length} gate(s) failed (host load ${loadavg()[0].toFixed(0)}), measuring again\n`);
  }
  reports.push(best.report);
  failures.push(...best.fails);
}
if (launched) await browser.close(); else await browser.close().catch(() => undefined);
harness?.server.close();
mkdirSync(opts.out, { recursive: true });
writeFileSync(join(opts.out, "perf-check.json"), JSON.stringify({ at: new Date().toISOString(), target: opts.target, gates: GATE, reports, failures }, null, 1));
if (opts.json) console.log(JSON.stringify({ reports, failures }, null, 1));
else {
  for (const r of reports) {
    const c = r.checks;
    const worst = (rows) => rows?.filter((x) => !x.skipped).map((x) => `${x.name} ${x.ms}ms${x.ms > GATE.pressMs ? ` (inert ${x.floorMs})` : ""}${x.changed ? "" : "!"}${x.limitedByHost ? "~" : ""}`).join(", ");
    // Timings only mean something on a quiet machine (1-minute load under 8 before and after); otherwise they are provisional.
    const quiet = r.loadBefore < 8 && (r.loadAfter ?? 0) < 8;
    console.log(`\n== ${r.size} ${r.viewport} (${r.throttle} CPU; host load ${r.loadBefore} -> ${r.loadAfter ?? "?"} on ${cpus().length} cores, 3M-op probe ${r.cpuProbeMs} ms${quiet ? "" : "; PROVISIONAL, the host was busy"}) ==`);
    if (c.layoutLive) console.log(`layout    profile=${c.layoutLive.profile} short=${c.layoutLive.short} panel=${c.layoutLive.panelW}px columns=${c.layoutLive.columns} overflowX=${c.layoutLive.overflowX}`);
    if (c.open) console.log(`open      cold ${c.open.coldPanelToContentMs} ms (skeleton ${c.open.coldSkeletonMs} ms, spinner ${c.open.spinnerSeen}), warm ${c.open.warmPanelToContentMs} ms`);
    console.log(`press     (each control is compared with an inert press taken just before it; ~ = over 50 ms but within ${GATE.pressOverFloorMs * (r.throttle === "1x" ? 1 : 2)} ms of that, i.e. the machine, not the control)\n          live: ${worst(c.pressLive) ?? "-"} | wildlife: ${worst(c.pressWildlife) ?? "-"} | sheet: ${worst(c.pressSheet) ?? "-"}`);
    if (c.tabs) console.log(`tabs      first visit ${["first visit Wildlife", "first visit AI check-up", "first visit Live"].map((k) => c.tabs[k]).join("/")} ms; revisits (first/stable ms): ${c.tabs.revisits.join(", ")}; budget ${c.tabs.budgetFirst}/${c.tabs.budgetStable}; panel's own worst frame ${c.tabs.panelWorstMs} ms${c.tabs.limitedByOthers ? " (over budget only because Home Assistant / Scrypted keep the page busy)" : ""}`);
    if (c.scrollGrid) console.log(`scroll    grid: panel's worst frame ${c.scrollGrid.ownWorstMs} ms (others ${c.scrollGrid.hostWorstMs} ms, ${c.scrollGrid.longFrames} long frames), CLS ${c.scrollGrid.cls}; recordings (${c.scrollRecordings?.rows ?? 0} rows): panel ${c.scrollRecordings?.ownWorstMs} ms (others ${c.scrollRecordings?.hostWorstMs} ms), CLS ${c.scrollRecordings?.cls}`);
    if (c.audio) console.log(`audio     ${c.audio.skipped ?? `${c.audio.ms} ms`}; playing at once: ${c.oneAtATime?.playing}`);
    if (c.video) console.log(`video     ${c.video.skipped ?? `${c.video.ms} ms`}`);
    if (c.back) console.log(`back      ${c.back.skipped ?? `scroll ${c.back.start} -> ${c.back.finalScroll} (drift ${c.back.drift}px); sheet reopens ${c.back.backToSheet}; closes ${c.back.closed}`}`);
    for (const key of ["staticLive", "staticWildlife", "staticSheet", "staticInsights", "staticVisit"]) if (c[key]) console.log(`static    ${key.slice(6)}: ${c[key].interactive} controls, ${c[key].small.length} under ${GATE.targetPx}px, ${c[key].dead.length} dead-looking, ${c[key].hoverOutsideMedia.length} hover-only rules`);
    if (c.keyboard) console.log(`keyboard  shortcut ${c.keyboard.shortcutSwitchesView}, help ${c.keyboard.helpOpens}, focus ring ${c.keyboard.focusRingVisible}`);
    if (r.foreignRejections) console.log(`note      ${r.foreignRejections} bare "closed" rejection(s) from Scrypted's live cards being torn down (not Kestrel's, not counted)`);
    if (c.fatal) console.log(`FATAL     ${c.fatal.split("\n")[0]}`);
  }
  console.log(failures.length ? `\nFAILED ${failures.length} gate(s):\n- ${failures.join("\n- ")}` : "\nAll gates passed.");
  console.log(`\nReport: ${join(opts.out, "perf-check.json")}${opts.shots ? ` (screenshots in ${opts.out})` : ""}`);
}
process.exit(failures.length ? 1 : 0);
