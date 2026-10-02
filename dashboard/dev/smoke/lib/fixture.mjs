// Shared pieces of the fixture smoke scripts (dev/smoke/fixture-*.mjs): they run the REAL panel bundle inside the mini Home Assistant
// (dev/harness.ts) against the dev server (dev/serve.mjs), so nothing here needs the real Home Assistant, a token or a relay.
//
//   runSmoke("name", async (fx) => { ... fx.check("what", ok, "detail") ... })
//
// Every script takes `--size WxH` (default 1280x800) and `--theme flat-light|flat-dark|glass-light|glass-dark` (default flat-light),
// prints one PASS / FAIL / SKIP line per check and exits non-zero when a check failed. Screenshots go to $OUT (default /tmp/kestrel-smoke).
// Run browsers politely on this busy host:  taskset -c 0-4,8-12 nice -n 15 node dev/smoke/fixture-back.mjs --size 390x844
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../../serve.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const OUT = process.env.OUT ?? "/tmp/kestrel-smoke";
export const MEDIA_PATH = "/api/kestrel/media/";
export const THEMES = ["flat-light", "flat-dark", "glass-light", "glass-dark"];

export const flag = (argv, name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at < 0 ? fallback : argv[at + 1] === undefined || argv[at + 1].startsWith("--") ? true : argv[at + 1];
};

/** The in-page helper every script uses: a deep query through open shadow roots. */
const PAGE_HELPERS = `
  window.__deep = (root, selector, out = []) => {
    root.querySelectorAll(selector).forEach((el) => out.push(el));
    root.querySelectorAll("*").forEach((el) => el.shadowRoot && window.__deep(el.shadowRoot, selector, out));
    return out;
  };
  window.__panelRoot = () => window.__deep(document, "kestrel-panel")[0]?.shadowRoot ?? null;
  window.__shown = (el) => { if (!el || !el.isConnected) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (!el.checkVisibility || el.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true })); };
  window.__inViewport = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth; };
`;

/** Launches the server, the browser and one page. Returns the fixture handle the scripts drive. */
export async function launch({ name, size, theme }) {
  mkdirSync(OUT, { recursive: true });
  const [width, height] = size;
  const touch = width < 800;
  const server = await startServer({});
  // The host is shared and its process limit is often close: a browser that dies while starting is tried again a few times.
  let browser, context, page;
  for (let attempt = 1; ; attempt += 1) {
    try {
      browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader"] });
      context = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch, deviceScaleFactor: touch ? 2 : 1, serviceWorkers: "block" });
      page = await context.newPage();
      break;
    } catch (error) {
      await browser?.close().catch(() => undefined);
      if (attempt >= 6) { await server.close().catch(() => undefined); throw error; }
      console.log(`INFO  browser did not start (attempt ${attempt}: ${String(error.message).split("\n")[0]}); retrying`);
      await new Promise((done) => setTimeout(done, 8000));
    }
  }
  await context.addInitScript(PAGE_HELPERS);

  // ---- signed media: the interceptor answers 401 for a link signed before the last restart ---------------------------------
  let currentEpoch = 0;
  await context.exposeFunction("__setEpoch", (epoch) => { currentEpoch = epoch; });
  const media = { perEpoch: new Map(), old401: 0, log: [] };
  const epochOf = (url) => { const match = /^e(\d+)$/.exec(new URL(url).searchParams.get("authSig") ?? ""); return match ? Number(match[1]) : -1; };
  await context.route(`**${MEDIA_PATH}**`, (route) => {
    if (epochOf(route.request().url()) < currentEpoch) return route.fulfill({ status: 401, contentType: "text/plain", body: "Unauthorized" });
    return route.continue();
  });
  const row = (epoch) => { let entry = media.perEpoch.get(epoch); if (!entry) { entry = { requests: 0, ok: 0, s401: 0, other: 0 }; media.perEpoch.set(epoch, entry); } return entry; };
  page.on("request", (request) => { if (request.url().includes(MEDIA_PATH)) row(epochOf(request.url())).requests += 1; });
  page.on("response", (response) => {
    const url = response.url();
    if (!url.includes(MEDIA_PATH)) return;
    const epoch = epochOf(url);
    const entry = row(epoch);
    const status = response.status();
    if (status < 400) entry.ok += 1;
    else if (status === 401) { entry.s401 += 1; if (epoch < currentEpoch) media.old401 += 1; }
    else entry.other += 1;
    media.log.push({ at: Date.now(), epoch, status, path: new URL(url).pathname.slice(MEDIA_PATH.length) });
  });

  // ---- console errors ----------------------------------------------------------------------------------------------------
  const errors = [];
  page.on("console", (message) => { if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) errors.push(message.text().slice(0, 240)); });
  page.on("pageerror", (error) => { if (String(error.message) !== "closed") errors.push(`pageerror: ${String(error).slice(0, 240)}`); }); // Scrypted's bare "closed" rejections are not the panel's

  const failures = [];
  let checks = 0;
  const tag = `${name}-${width}x${height}-${theme}`;
  const fx = {
    page, context, server, media, errors, width, height, theme, touch, tag,
    get epoch() { return currentEpoch; },

    /** Prints one line per check; a failing check also keeps a screenshot (once per check name). */
    async check(label, ok, detail = "") {
      checks += 1;
      if (ok) { console.log(`PASS  ${label}${detail ? `  [${detail}]` : ""}`); return true; }
      failures.push(label);
      console.log(`FAIL  ${label}${detail ? `  [${detail}]` : ""}`);
      await fx.shot(`FAIL-${label.replace(/[^a-z0-9]+/gi, "-").slice(0, 50)}`).catch(() => undefined);
      return false;
    },
    skip(label, why) { console.log(`SKIP  ${label}  [${why}]`); },
    info(text) { console.log(`INFO  ${text}`); },
    async shot(label) {
      const path = `${OUT}/${tag}-${label}.png`;
      await page.screenshot({ path });
      return path;
    },

    /** Opens `path` (an address inside the mini Home Assistant) in the current theme and waits until the panel has rendered its shell. */
    async open(path, { epoch } = {}) {
      const url = new URL(path, server.url);
      if (!url.searchParams.has("theme")) url.searchParams.set("theme", theme);
      if (epoch !== undefined) url.searchParams.set("epoch", String(epoch));
      // Every open is a fresh "tab" as far as history goes: the entry before the panel is a blank page, so "Back leaves the panel" is real.
      if (page.url() !== "about:blank") await page.goto("about:blank");
      await page.goto(url.href, { waitUntil: "domcontentloaded" });
      await fx.waitForPanel();
    },
    async waitForPanel() {
      await page.waitForFunction(() => window.__panelRoot?.()?.querySelector("kestrel-lu-app-shell"), null, { timeout: 30000 });
    },

    /** Runs `fn(deep, arg)` inside the page; `deep(root, selector)` finds elements through shadow roots. */
    ev: (fn, arg) => page.evaluate(({ source, value }) => (0, eval)(source)(window.__deep, value), { source: fn.toString(), value: arg ?? null }),
    /** Polls `fn()` (node side) until it returns something truthy; returns the value, or null after `timeout` ms. */
    async poll(fn, { timeout = 5000, every = 60 } = {}) {
      const until = Date.now() + timeout;
      for (;;) {
        let value = null;
        try { value = await fn(); } catch { /* the page is between documents */ }
        if (value) return value;
        if (Date.now() > until) return null;
        await page.waitForTimeout(every);
      }
    },
    settle: (ms = 350) => page.waitForTimeout(ms),

    /** Where we are in the history: the Navigation API's entry index (exact, unlike history.length which keeps forward entries). */
    nav: () => page.evaluate(() => ({ index: navigation.currentEntry.index, length: navigation.entries().length, path: location.pathname, search: location.search, historyLength: history.length })),
    /** Browser Back (what the phone's Back does). */
    async back() { await page.evaluate(() => history.back()).catch(() => undefined); /* leaving the page destroys the context mid-call */ await fx.settle(450); },
    async key(name) { await page.keyboard.press(name); await fx.settle(450); },
    left: () => /^\/kestrel(\/|$)/.test(new URL(page.url()).pathname) === false,

    /** Panel pieces. Everything is looked up through shadow roots. */
    panel: {
      view: () => fx.ev(() => window.__panelRoot()?.querySelector("kestrel-lu-view-stack")?.current ?? null),
      navCurrent: () => fx.ev((deep) => deep(window.__panelRoot(), 'a[aria-current="page"]').filter((a) => window.__shown(a)).map((a) => a.getAttribute("href")).filter(Boolean).pop() ?? null),
      layerOpen: (layer) => fx.ev((deep, wanted) => deep(window.__panelRoot(), `kestrel-lu-sheet[layer="${wanted}"]`).some((sheet) => sheet.hasAttribute("open")), layer),
      speciesOpen: () => fx.panel.layerOpen("species"),
      count: (selector) => fx.ev((deep, wanted) => deep(window.__panelRoot(), wanted).filter((el) => window.__shown(el)).length, selector),
    },
    /** Taps a tab link of the app shell (any width: rail, pill bar or bottom bar). */
    async tab(id) {
      const link = page.locator(`kestrel-lu-nav a[href$="/${id}"]:visible`).first();
      await link.click({ timeout: 8000 });
      await fx.settle(500);
    },

    /** Reports the fixture's counters. */
    mediaSummary() {
      return [...media.perEpoch.entries()].sort(([a], [b]) => a - b).map(([epoch, e]) => `e${epoch}: ${e.requests} requests, ${e.ok} ok, ${e.s401} x 401, ${e.other} other`).join("; ") || "no media requests";
    },

    /** Prints the verdict, closes everything, exits non-zero when something failed. */
    async finish() {
      await fx.check("no console errors", errors.length === 0, errors.slice(0, 3).join(" | ") || "none");
      console.log(`${failures.length ? "FAILED" : "PASSED"}  ${tag}: ${checks - failures.length}/${checks} checks${failures.length ? `, failing: ${failures.join("; ")}` : ""}`);
      await browser.close().catch(() => undefined);
      await server.close().catch(() => undefined);
      process.exit(failures.length ? 1 : 0);
    },
  };
  fx.close = async () => { await browser.close().catch(() => undefined); await server.close().catch(() => undefined); };
  fx.root = root;
  return fx;
}

/** Parses the arguments, runs `body(fx)`, and always prints the verdict. A crash inside `body` is a FAIL, not a silent exit. */
export async function runSmoke(name, body, { watchdogSeconds = 300 } = {}) {
  const argv = process.argv.slice(2);
  const size = String(flag(argv, "size", "1280x800")).split("x").map(Number);
  const theme = String(flag(argv, "theme", "flat-light"));
  if (size.length !== 2 || size.some((n) => !(n > 0)) || !THEMES.includes(theme)) {
    console.error(`usage: node dev/smoke/${name}.mjs [--size WxH] [--theme ${THEMES.join("|")}]`);
    process.exit(2);
  }
  const fx = await launch({ name, size, theme });
  const timer = setTimeout(() => { console.log(`FAIL  watchdog: ${name} ran longer than ${watchdogSeconds} s`); fx.close().finally(() => process.exit(1)); }, watchdogSeconds * 1000);
  timer.unref();
  console.log(`# ${name}  ${size.join("x")}  ${theme}`);
  try {
    await body(fx);
  } catch (error) {
    await fx.check("script ran to the end", false, String(error?.stack ?? error).split("\n").slice(0, 3).join(" / "));
  }
  await fx.finish();
}
