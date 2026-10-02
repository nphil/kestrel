#!/usr/bin/env node
// The user-visible requirements, proven on the REAL Home Assistant in the SHARED browser (the one the user watches).
//   taskset -c 0-4,8-12 nice -n 15 node dev/smoke/real-matrix.mjs [--bundle local|installed | --bundle-file PATH] [--sizes phone,smart,tablet,desktop,wide]
//                                                                   [--themes flat-light,glass-dark] [--only GROUP] [--out /tmp/kestrel-matrix]
// 10 cells = 5 sizes x 2 themes. Each cell prints one PASS / FAIL / SKIP line per check; the end prints one table and writes
// $OUT/results.json. Exits non-zero when a check failed. Timing numbers are PROVISIONAL on a busy host (the load is printed before/after).
// Run it under `flock /tmp/lucent-ha-browser.lock` (one of our tabs in the shared Chromium at a time) and, being heavy, under
// /data/home/tmp/normalload/withlock.sh.
//
//   --bundle local        (default) the newest file in custom_components/kestrel/frontend is served into the real page by request interception.
//   --bundle-file PATH    that file (e.g. a scratch build from dashboard/build.mjs or /data/home/tmp/kperf/build-variant.mjs) is served the same way,
//                         so a build can be proven before it is released.
//   --bundle installed    no interception: the bundle Home Assistant serves (the post-release run).
// The end of the run prints which bundle was served: the file and its sha256, and the hash of what the page received.
//
// Sheet groups (--only): wildlife (the species sheet, ids 5.*), visit (the "What was it?" picker, 7.*), keys (the shortcut help sheet, 12.*).
// Each of the three sheets is proven for: Back / Esc / scrim, focus on open, Tab trap, focus returned to the opener, page scroll lock (wheel,
// keys, touch), safe-area insets (Emulation.setSafeAreaInsetsOverride), geometry per size, swipe down (bottom sheet) and theme following.
//
// It attaches to the already-running shared Chromium (CDP, default http://127.0.0.1:43977), reuses its page, and puts everything back
// at the end: emulation (size, touch, safe-area insets), the request route, the address and, when the browser was logged out at the start,
// its storage (logged out again). Themes are worn CLIENT-SIDE only (home-assistant._updateHass + _applyTheme(false), as perf-check does): the
// `settheme` event would overwrite the theme profile Home Assistant keeps on the server for the token's user, so it is never used here.
// It NEVER writes real data: no correction, confirm, mute or setting is ever pressed ("That's right" and the picker's species rows are never tapped).
// Needs the relay on 127.0.0.1:8124 and, only when the browser is logged out, /data/home/tmp/ha-token (never printed).
import { chromium } from "playwright-core";
import { mkdirSync, readFileSync, readdirSync, statSync, existsSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const argv = process.argv.slice(2);
const flag = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i < 0 ? fallback : (argv[i + 1] === undefined || argv[i + 1].startsWith("--") ? true : argv[i + 1]); };
const BASE = String(flag("base", "http://127.0.0.1:8124"));
const CDP = String(flag("cdp", "http://127.0.0.1:43977"));
const OUT = String(flag("out", "/tmp/kestrel-matrix"));
const BUNDLE_FILE = flag("bundle-file", null);
if (BUNDLE_FILE === true) { console.error("--bundle-file PATH"); process.exit(2); }
if (BUNDLE_FILE && argv.includes("--bundle")) { console.error("use --bundle OR --bundle-file, not both"); process.exit(2); }
const BUNDLE = BUNDLE_FILE ? "file" : String(flag("bundle", "local"));
const ONLY = flag("only", null); // --only keys|live|wildlife|visit|preview : run one group of checks (a quick re-proof), no table for the rest
const STEPS = flag("steps", null) ? new Set(String(flag("steps", "")).split(",").filter(Boolean)) : null; // --steps trap,focus : only these in-depth sheet checks (ids <prefix>.<step>)
const TOKEN_FILE = String(flag("token-file", "/data/home/tmp/ha-token"));
mkdirSync(OUT, { recursive: true });

// ---- the matrix -----------------------------------------------------------------------------------------------------------------
const SIZES = {
  phone: { w: 390, h: 844, touch: true, mobile: true, nav: "bottom" },
  smart: { w: 960, h: 480, touch: true, mobile: false, nav: "rail" },
  tablet: { w: 820, h: 1180, touch: true, mobile: true, nav: "pills" },
  desktop: { w: 1920, h: 1080, touch: false, mobile: false, nav: "tabs" },
  wide: { w: 2560, h: 1440, touch: false, mobile: false, nav: "tabs" },
};
const THEMES = {
  "flat-light": { name: "Neumorphism", dark: false, code: "FL" },
  "glass-dark": { name: "Caule Black Blue Glass", dark: true, code: "GD" },
};
// The worn themes of the live theme switch (9.theme and the sheets' *.theme): flat-dark is not a matrix column.
const CYCLE = [{ key: "flat-light", name: "Neumorphism", dark: false }, { key: "glass-dark", name: "Caule Black Blue Glass", dark: true }, { key: "flat-dark", name: "Neumorphism", dark: true }, { key: "flat-light", name: "Neumorphism", dark: false }];
const THEME_BY_KEY = Object.fromEntries(CYCLE.map((t) => [t.key, t]));
const wantSizes = String(flag("sizes", Object.keys(SIZES).join(","))).split(",").filter(Boolean);
const wantThemes = String(flag("themes", Object.keys(THEMES).join(","))).split(",").filter(Boolean);
for (const s of wantSizes) if (!SIZES[s]) { console.error(`unknown size ${s}; use ${Object.keys(SIZES).join(", ")}`); process.exit(2); }
for (const t of wantThemes) if (!THEMES[t]) { console.error(`unknown theme ${t}; use ${Object.keys(THEMES).join(", ")}`); process.exit(2); }
if (!["local", "installed", "file"].includes(BUNDLE)) { console.error("--bundle local|installed, or --bundle-file PATH"); process.exit(2); }
if (BUNDLE === "file" && !existsSync(resolve(String(BUNDLE_FILE)))) { console.error(`--bundle-file ${BUNDLE_FILE}: no such file`); process.exit(2); }

// What a sheet is proven for (see proveSheet): id suffix -> what the check shows. The ids are <prefix>.<suffix>.
const SHEET_CHECK = {
  back: "Back closes ONLY the sheet", escape: "Escape closes it", scrim: "scrim: only a press that began and ended there",
  focus: "focus goes in (touch: the sheet, never a field)", trap: "Tab / Shift+Tab stay inside", return: "focus returns to the opener (Esc, X, Back, scrim)",
  lock: "page cannot scroll behind (wheel, keys, touch)", safe: "safe-area insets respected", geometry: "placement + close button >= 44 px",
  swipe: "swipe down closes (bottom sheet)", theme: "follows the HA theme live (4 switches + blur stand-ins)",
  dim: "scrim darkens the page like the theme's brightness (pixels, 2/255)", fade: "scrim + panel fade in and out (no pop)",
};
function sheetChecks(prefix, name, suffixes) { return suffixes.map((s) => [`${prefix}.${s}`, `${name}: ${SHEET_CHECK[s]}`]); }
// The in-depth sheet checks of each sheet (ids <prefix>.<suffix>) and the ids alone (for "skipped / failed together" lists).
const SHEET_ROWS = {
  5: sheetChecks("5", "species sheet", ["focus", "trap", "return", "lock", "safe", "geometry", "swipe", "theme", "dim", "fade"]),
  7: sheetChecks("7", "picker", ["escape", "scrim", "focus", "trap", "return", "lock", "safe", "geometry", "swipe", "theme", "dim", "fade"]),
  12: sheetChecks("12", "shortcut help", ["back", "escape", "scrim", "focus", "trap", "return", "lock", "safe", "geometry", "swipe", "theme", "dim", "fade"]),
};
const SHEET_IDS = Object.fromEntries(Object.entries(SHEET_ROWS).map(([prefix, rows]) => [prefix, rows.map(([id]) => id)]));
const CHECKS = [
  ["1.pinned", "app bar pinned on scroll"], ["1.nav", "destinations in the fitting layout"], ["1.overflow", "no horizontal overflow"],
  ["1.tiles", "camera tiles + grid columns"], ["1.errors", "no console errors (whole cell)"],
  ["2.menu", "HA menu button iff drawer"], ["2.open", "menu tap opens HA drawer"], ["2.toggle", "second tap closes drawer"], ["2.escape", "Escape closes drawer"],
  ["3.focus", "tile -> focused camera (ms)"], ["3.picture", "picture/video frame (ms, PROVISIONAL)"], ["3.back", "'All cameras' returns to grid"], ["3.snapshot", "snapshot-only camera shows picture"],
  ["4.tiles", "wildlife tiles shown"], ["4.filter", "filter All/On camera/Heard + counts"], ["4.cycle", "Heard/On camera/All change tiles"], ["4.badges", "evidence badges video/waveform"],
  ["5.open", "species sheet opens, ?s="], ["5.sections", "On camera + Heard sections"], ["5.play", "recording plays"], ["5.pause", "second tap pauses"],
  ["5.back", "Back closes ONLY the sheet"], ["5.escape", "Escape closes the sheet"], ["5.scrim", "scrim: only a press that began there"],
  ...SHEET_ROWS[5],
  ["6.player", "heard visit: player + Original toggle"], ["6.switch", "Original switches source and back"], ["6.cleaned", "'Cleaned' mark"],
  ["7.visit", "recording row -> visit page"], ["7.picker", "'Wrong?' opens picker"], ["7.backpicker", "Back closes ONLY the picker"], ["7.backsheet", "Back -> species sheet"], ["7.backlist", "Back -> list, same scroll"],
  ...SHEET_ROWS[7],
  ["8.wild", "Wildlife keeps its scroll"], ["8.live", "Live keeps its scroll"],
  ["9.theme", "theme switch live (sheet open)"], ["10.keys", "keys 2, 1, shortcut button, Esc (non-touch)"], ["11.shots", "6 screenshots written"],
  ...SHEET_ROWS[12],
];

// ---- output ---------------------------------------------------------------------------------------------------------------------
const load = () => readFileSync("/proc/loadavg", "utf8").split(" ").slice(0, 3).join(" ");
const results = []; // { cell, id, status, detail }
const fails = [];
let cell = null;
const mark = (id, status, detail = "") => {
  results.push({ cell: cell.key, id, status, detail });
  console.log(`${status.padEnd(4)}  [${cell.key}] ${id} ${CHECKS.find(([k]) => k === id)?.[1] ?? ""}${detail ? `  -- ${detail}` : ""}`);
  if (status === "FAIL") fails.push({ cell: cell.key, id, detail });
};
const pass = (id, detail) => mark(id, "PASS", detail);
const fail = async (id, detail) => { mark(id, "FAIL", detail); await shotTo(`FAIL-${cell.key.replace(/[^a-z0-9]+/gi, "_")}-${id}`).catch(() => undefined); };
const skip = (id, why) => mark(id, "SKIP", why);
const verdict = (id, ok, detail) => (ok ? pass(id, detail) : fail(id, detail));

// ---- the shared browser -----------------------------------------------------------------------------------------------------------
const browser = await chromium.connectOverCDP(CDP);
const context = browser.contexts()[0];
// The run works in a tab of its own (opened in front, closed at the end). The shared browser has other users' tabs too; a tab that is not in front draws no
// animation frames and its screenshots time out, and a tab someone else drives would lose this run's helpers mid-check.
const page = await context.newPage();
await page.bringToFront();
const cdp = await context.newCDPSession(page);
const errors = [];
// Scrypted's own camera card (a third-party component) logs its own failures: RpcPeer, engine.io, node:events. They are counted, not blamed on Kestrel.
const thirdParty = (text) => /RpcPeer|@scrypted|engine\.io|node:[a-z_/]+|scrypted/i.test(text);
let ignored = 0;
const record = (text) => { if (thirdParty(text)) ignored += 1; else errors.push(text.slice(0, 220)); };
const onConsole = (m) => { if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) record(m.text()); };
const onPageError = (e) => { if (String(e.message) !== "closed") record(`pageerror: ${String(e.message ?? e)}${e.stack ? ` ${e.stack}` : ""}`); };

let localFile = null; // "<name> sha256:<12 hex>" of the file served by interception
let servedHash = null; // sha256 (hex) of the bytes served by interception
let routed = 0;
const ROUTE = "**/kestrel-static/kestrel.*.js*";
if (BUNDLE === "local" || BUNDLE === "file") {
  let file;
  if (BUNDLE === "file") file = resolve(String(BUNDLE_FILE));
  else {
    const dir = join(root, "custom_components/kestrel/frontend");
    file = readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => join(dir, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  }
  const body = readFileSync(file);
  servedHash = createHash("sha256").update(body).digest("hex");
  localFile = `${BUNDLE === "file" ? file : file.split("/").pop()} sha256:${servedHash.slice(0, 12)}`;
  await page.route(ROUTE, (route) => { routed += 1; return route.fulfill({ status: 200, contentType: "application/javascript", body }); });
}

// A browser that was logged out when the run began is logged out again at its end: what localStorage held then is kept here.
let loggedOutAtStart = false;
let storageAtStart = [];
async function ensureLogin() {
  let has = await page.evaluate(() => !!localStorage.getItem("hassTokens")).catch(() => null);
  if (has) return;
  const token = readFileSync(TOKEN_FILE, "utf8").trim();
  if (has === null) { // a fresh tab is on about:blank: load the origin to see its storage (shared with the other tabs)
    await page.goto(`${BASE}/auth/authorize`, { waitUntil: "domcontentloaded" }).catch(() => undefined);
    has = await page.evaluate(() => !!localStorage.getItem("hassTokens")).catch(() => null);
    if (has) return;
  }
  storageAtStart = await page.evaluate(() => Object.entries(localStorage));
  loggedOutAtStart = true;
  await page.evaluate(([t, base]) => localStorage.setItem("hassTokens", JSON.stringify({ access_token: t, token_type: "Bearer", expires_in: 1800, hassUrl: base, clientId: `${base}/`, expires: Date.now() + 365 * 864e5, refresh_token: "" })), [token, BASE]);
}

async function emulate(c) {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: c.size.w, height: c.size.h, deviceScaleFactor: 1, mobile: c.size.mobile });
  if (c.size.touch) await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
}
/** Chrome's own phone-notch stand-in: env(safe-area-inset-*) answers these numbers until they are set back to 0. */
const setInsets = (insets) => cdp.send("Emulation.setSafeAreaInsetsOverride", { insets });
async function clearEmulation() {
  await setInsets({ top: 0, bottom: 0, left: 0, right: 0 }).catch(() => undefined);
  await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => undefined);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false }).catch(() => undefined);
}

// ---- in-page helpers (injected after every full load) -----------------------------------------------------------------------------
const inject = () => page.evaluate(() => {
  window.__deep = (r, s, o = []) => { r.querySelectorAll(s).forEach((e) => o.push(e)); r.querySelectorAll("*").forEach((e) => e.shadowRoot && window.__deep(e.shadowRoot, s, o)); return o; };
  window.__panel = () => window.__deep(document, "kestrel-panel")[0]?.shadowRoot ?? null;
  window.__shell = () => window.__panel()?.querySelector("kestrel-lu-app-shell") ?? null;
  window.__shown = (el) => { if (!el || !el.isConnected) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (!el.checkVisibility || el.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true })); };
  window.__scroller = () => {
    const s = window.__shell()?.luScroller;
    if (s) return s;
    const se = document.scrollingElement;
    return { get top() { return se.scrollTop; }, scrollTo(t) { window.scrollTo({ top: t, behavior: "instant" }); }, element: se };
  };
  window.__max = () => { const el = window.__scroller().element ?? document.scrollingElement; return el.scrollHeight - el.clientHeight; };
  window.__in = (root, tag, sel) => window.__deep(root, tag).flatMap((e) => [...(e.shadowRoot?.querySelectorAll(sel) ?? [])]);
  window.__nav = () => window.__in(window.__shell().shadowRoot, "kestrel-lu-nav", "a.item");
  window.__nonce = window.__nonce ?? Math.random();
  // ---- sheets: the parts of a <kestrel-lu-sheet> (the toolkit's native <dialog> engine), where focus is, where the page is ----
  window.__sheetParts = (layer) => {
    const s = window.__deep(window.__panel(), `kestrel-lu-sheet[layer="${layer}"]`)[0] ?? null;
    const q = (sel) => s?.shadowRoot?.querySelector(sel) ?? null;
    return { s, dialog: q("dialog"), scrim: q(".scrim"), panel: q(".panel"), head: q(".head"), titles: q(".titles"), body: q(".body"), footer: q(".footer"), close: q("button.close"), handle: q(".handle") };
  };
  window.__active = () => { let a = document.activeElement; while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement; return a; };
  window.__within = (el, host) => { for (let n = el; n; n = n.parentNode ?? n.host ?? null) if (n === host) return true; return false; };
  window.__box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; };
  window.__desc = (el) => (!el ? "nothing" : `${el.localName}${el.id ? `#${el.id}` : ""}${typeof el.className === "string" && el.className ? `.${el.className.trim().split(/\s+/)[0]}` : ""}${el.getAttribute?.("aria-label") ? `[${el.getAttribute("aria-label").slice(0, 24)}]` : ""}`);
  window.__top = () => ({ page: Math.round(window.__scroller().top), win: Math.round(window.scrollY) });
});
const ev = (fn, arg) => page.evaluate(fn, arg);
const handle = async (fn, arg) => (await page.evaluateHandle(fn, arg)).asElement();
const sleep = (ms) => page.waitForTimeout(ms);
async function poll(fn, { timeout = 6000, every = 80 } = {}) {
  const until = Date.now() + timeout;
  for (;;) {
    let value = null;
    try { value = await fn(); } catch { /* between documents */ }
    if (value) return value;
    if (Date.now() > until) return null;
    await sleep(every);
  }
}
const where = () => page.evaluate(() => `${location.pathname}${location.search}`);
const back = async () => { await page.evaluate(() => history.back()).catch(() => undefined); await sleep(500); };
const shotTo = (name) => page.screenshot({ path: `${OUT}/${name}.png` });
const shot = async (step) => { const path = `${OUT}/${cell.theme.name === "Neumorphism" ? "flat-light" : "glass-dark"}-${cell.size.w}x${cell.size.h}-${step}.png`; await page.screenshot({ path }); cell.shots.add(step); return path; };

// Real input. Touch sizes use CDP touch events (a finger); the others a mouse.
async function tapAt(x, y) {
  if (cell.size.touch) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await sleep(60);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } else {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await sleep(40);
    await page.mouse.up();
  }
}
async function tap(h) {
  if (!h) throw new Error("tap: element not found");
  await h.scrollIntoViewIfNeeded().catch(() => undefined);
  const box = await h.boundingBox();
  if (!box) throw new Error("tap: element has no box");
  await tapAt(box.x + box.width / 2, box.y + box.height / 2);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
async function drag(from, to) {
  if (cell.size.touch) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [from] });
    for (let i = 1; i <= 6; i += 1) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from.x + ((to.x - from.x) * i) / 6, y: from.y + ((to.y - from.y) * i) / 6 }] });
      await sleep(16);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } else {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 6 });
    await page.mouse.up();
  }
}

// Page pieces. All of them look through open shadow roots.
const tabHandle = (id) => handle((want) => window.__nav().find((a) => (a.getAttribute("href") ?? "").endsWith(`/${want}`) && window.__shown(a)) ?? null, id);
// A tab tap that did not switch the view is tried once more and said out loud (it is a finding if it happens on the real page).
const gotoTab = async (id) => {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await tap(await tabHandle(id));
    await sleep(600);
    if (await poll(async () => (await currentView()) === id, { timeout: 3000, every: 150 })) return;
    console.log(`INFO  [${cell.key}] tab "${id}" tap ${attempt} did not switch the view (still "${await currentView()}")`);
  }
};
const currentView = () => ev(() => window.__panel()?.querySelector("kestrel-lu-view-stack")?.current ?? null);
const sheetState = (layer) => ev((want) => {
  const s = window.__deep(window.__panel(), `kestrel-lu-sheet[layer="${want}"]`)[0];
  if (!s) return { exists: false, open: false, dialog: false };
  const dlg = window.__deep(s.shadowRoot, "dialog").find((d) => d.open);
  const r = dlg?.getBoundingClientRect();
  return { exists: true, open: s.hasAttribute("open"), dialog: !!dlg && r.width > 0 && r.height > 0 };
}, layer);
const sheetUp = async (layer, timeout = 6000) => poll(async () => { const s = await sheetState(layer); return s.open && s.dialog ? s : null; }, { timeout });
const sheetGone = async (layer, timeout = 5000) => poll(async () => { const s = await sheetState(layer); return !s.open && !s.dialog; }, { timeout });
const sidebarVisible = () => ev(() => { const s = window.__deep(document, "ha-sidebar")[0]; if (!s) return false; const r = s.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.right > 8; });
const speciesTile = (name) => handle((want) => {
  const tiles = window.__deep(window.__panel(), "button.species-tile");
  return (want ? tiles.find((t) => (t.getAttribute("aria-label") ?? "").startsWith(`${want}.`)) : tiles.find((t) => /recording|video/.test(t.getAttribute("aria-label") ?? ""))) ?? null;
}, name);
const tileLabel = (h) => h.evaluate((el) => el.getAttribute("aria-label") ?? "");

/** Puts a Home Assistant theme on the PAGE only: what the Profile setting does to the page (update its own state, apply the theme), without the
 * save. Home Assistant 2026.9 keeps the theme in the user's profile on the server, and its `settheme` event would overwrite that profile (Nitin's
 * is Neumorphism / light). A fresh load wears the profile's theme again. */
async function wearTheme(theme, settleMs = 1200) {
  const worn = await ev(({ name, dark }) => {
    const ha = document.querySelector("home-assistant");
    if (!ha || typeof ha._updateHass !== "function" || typeof ha._applyTheme !== "function") return false;
    ha._updateHass({ selectedTheme: { ...ha.hass.selectedTheme, theme: name, dark } });
    ha._applyTheme(false);
    return true;
  }, { name: theme.name, dark: theme.dark });
  if (!worn) throw new Error("this Home Assistant does not offer the page's theme hooks (_updateHass, _applyTheme)");
  await sleep(settleMs);
}
async function open(path, c, ready) {
  // The host is busy and the relay has dropped a request now and then: a failed load is tried again (3 times) before it counts.
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
      if (await poll(() => page.evaluate(() => !!document.querySelector("home-assistant")?.hass?.connection), { timeout: 40000, every: 200 })) break;
      throw new Error("Home Assistant did not connect");
    } catch (error) {
      if (attempt >= 3) throw error;
      console.log(`INFO  load of ${path} failed (${String(error.message).split("\n")[0].slice(0, 80)}), trying again`);
      await sleep(8000);
    }
  }
  await inject();
  await wearTheme(c.theme);
  await poll(() => ev(() => !!window.__shell()), { timeout: 40000, every: 200 });
  if (ready) await poll(() => ev(ready), { timeout: 40000, every: 200 });
  await sleep(800);
}
const countTiles = (sel) => ev((want) => window.__deep(window.__panel(), want).length, sel);
/** The species grid shows 24 tiles and a "Show more species" button for the rest (kestrel-cameras.ts `_speciesVisible`, reset by every filter change): press it until
 * everything is on the page, then scroll back to the top. */
async function expandAllSpecies() {
  for (let more = 0; more < 12; more += 1) {
    const button = await handle(() => window.__deep(window.__panel(), 'kestrel-lu-button[label="Show more species"]').find((b) => window.__shown(b)) ?? null);
    if (!button) break;
    await tap(button);
    await sleep(500);
  }
  await ev(() => window.__scroller().scrollTo(0));
  await sleep(300);
}

const findHeard = () => ev(async () => {
  try {
    const r = await document.querySelector("home-assistant").hass.callWS({ type: "kestrel/visits", kind: "heard", limit: 30 });
    const ready = (r.items ?? r).filter((v) => v.audioOriginal && v.audioInfo?.state === "ready");
    const item = ready.find((v) => v.audioInfo?.cleaned) ?? ready[0];
    return item ? { id: item.id, original: item.audioOriginal, cleaned: !!item.audioInfo?.cleaned, species: item.species } : { none: true, count: (r.items ?? r).length };
  } catch (error) { return { error: String(error?.message ?? error).slice(0, 120) }; }
});

// ---- the sheets ---------------------------------------------------------------------------------------------------------------------
// Home Assistant's own dialog used to give the three Kestrel sheets Back, Esc, scrim, focus, a focus trap, a scroll lock, safe areas and the theme.
// Now the toolkit's native <dialog> sheet draws them, so every one of those is proven here, on the real page, for each sheet.
const INSETS = { top: 30, bottom: 34, left: 18, right: 22 };
const ZERO_INSETS = { top: 0, bottom: 0, left: 0, right: 0 };
/** Where the toolkit puts a sheet (see its sheet.ts): VIEWPORT narrower than 680 = bottom sheet; from 900, or from 680 and 500 high or less = side pane; else centred. */
const sheetMode = (w, h) => (w < 680 ? "bottom" : w >= 900 || h <= 500 ? "side" : "centred");
const near = (a, b, tol = 1.5) => Math.abs(a - b) <= tol;
const sheetParts = (layer) => ev((l) => { const p = window.__sheetParts(l); return { exists: !!p.s, native: !!p.dialog }; }, layer);
/** A point on the scrim, outside the panel; null when the panel leaves no 30 px margin anywhere. */
const scrimPoint = (layer) => ev((l) => {
  const a = window.__box(window.__sheetParts(l).panel);
  if (!a) return null;
  const w = innerWidth, h = innerHeight;
  if (a.t >= 30) return { x: w / 2, y: Math.max(8, a.t / 2), at: "above the panel" };
  if (a.l >= 30) return { x: a.l / 2, y: h / 2, at: "left of the panel" };
  if (w - a.r >= 30) return { x: a.r + (w - a.r) / 2, y: h / 2, at: "right of the panel" };
  if (h - a.b >= 30) return { x: w / 2, y: a.b + (h - a.b) / 2, at: "below the panel" };
  return null;
}, layer);
/** Focuses the opener the way a keyboard user arrives on it (without scrolling the page); true when it holds focus. */
async function focusOpener(spec) {
  const h = await spec.opener();
  if (!h) throw new Error("the opener is not on the page");
  return h.evaluate((el) => { const inner = el.shadowRoot?.querySelector("button, a[href]") ?? el; inner.focus({ preventScroll: true }); return window.__active() === inner; });
}
const openByKeyboard = async (spec) => { if (!(await focusOpener(spec))) throw new Error("the opener would not take focus"); await page.keyboard.press("Enter"); return sheetUp(spec.layer, 8000); };
const openByTap = async (spec) => { await tap(await spec.opener()); return sheetUp(spec.layer, 8000); };
/** Closes the sheet one way; true when it is gone. */
async function closeBy(spec, how) {
  if (how === "escape") await page.keyboard.press("Escape");
  else if (how === "button") await tap(await handle((l) => window.__sheetParts(l).close, spec.layer));
  else if (how === "back") await back();
  else if (how === "scrim") { const p = await scrimPoint(spec.layer); if (!p) return false; await tapAt(p.x, p.y); }
  return !!(await sheetGone(spec.layer, 5000));
}
async function ensureClosed(spec) {
  for (const how of ["escape", "back"]) { if (!(await sheetState(spec.layer)).open) break; await closeBy(spec, how); }
  await sleep(150);
}
/** Waits until the enter motion of the open sheet is over (its scrim, dim layer and panel animations have finished), at most 3 s. */
const motionDone = (layer) => ev(async (l) => {
  const P = window.__sheetParts(l);
  const animations = P.s ? [...P.s.shadowRoot.querySelectorAll(".scrim, .dim, .panel")].flatMap((e) => e.getAnimations()) : [];
  await Promise.race([Promise.all(animations.map((a) => a.finished.catch(() => undefined))), new Promise((done) => setTimeout(done, 3000))]);
}, layer);
async function ensureOpen(spec) {
  if ((await sheetState(spec.layer)).open) return;
  if (!(await openByTap(spec))) throw new Error("the sheet did not open");
  await motionDone(spec.layer);
  await sleep(250);
}

/** Proves one sheet. `spec`: { prefix, layer, opener(): ElementHandle that opens it, extras: ["back"|"escape"|"scrim"] (the ones not proven elsewhere) }.
 * The sheet is closed when it starts and when it ends. Every check is its own step: a throw fails only that id. */
async function proveSheet(spec) {
  const w = cell.size.w, h = cell.size.h, mode = sheetMode(w, h);
  const id = (k) => `${spec.prefix}.${k}`;
  const urlBefore = await where();
  const isNative = async () => (await sheetParts(spec.layer)).native; // asked while the sheet is open: a closed sheet may not be rendered at all
  const step = async (k, fn) => {
    if (STEPS && !STEPS.has(k)) return;
    try { await fn(); } catch (error) {
      if (!results.some((r) => r.cell === cell.key && r.id === id(k))) await fail(id(k), `threw: ${String(error?.message ?? error).split("\n")[0].slice(0, 200)}`);
      await setInsets(ZERO_INSETS).catch(() => undefined);
      await ev(() => { document.getElementById("__sca-spacer")?.remove(); document.getElementById("__sca-strip")?.remove(); }).catch(() => undefined);
      await ensureClosed(spec).catch(() => undefined);
    }
  };
  const onlyNative = (k, fn) => step(k, async () => {
    await ensureOpen(spec);
    if (!(await isNative())) skip(id(k), "this sheet is drawn by Home Assistant's dialog (engine ha), not the toolkit's native one");
    else await fn();
  });

  // ---- Back / Escape / scrim for the sheets that did not have them yet ----
  if (spec.extras.includes("back")) await step("back", async () => {
    await ensureClosed(spec);
    if (!(await openByTap(spec))) throw new Error("the sheet did not open");
    await sleep(500);
    await back();
    const gone = await sheetGone(spec.layer);
    const now = await where();
    await verdict(id("back"), !!gone && now === urlBefore, `sheet ${gone ? "closed" : "STILL OPEN"} by history.back(), ${now} (was ${urlBefore})`);
  });
  if (spec.extras.includes("escape")) await step("escape", async () => {
    await ensureClosed(spec);
    if (!(await openByTap(spec))) throw new Error("the sheet did not open");
    await sleep(500);
    await page.keyboard.press("Escape");
    const gone = await sheetGone(spec.layer);
    const now = await where();
    await verdict(id("escape"), !!gone && now === urlBefore, `sheet ${gone ? "closed" : "STILL OPEN"} by Escape, ${now} (was ${urlBefore})`);
  });
  if (spec.extras.includes("scrim")) await onlyNative("scrim", async () => {
    await ensureClosed(spec);
    if (!(await openByTap(spec))) throw new Error("the sheet did not open");
    await sleep(800);
    const p = await scrimPoint(spec.layer);
    if (!p) { skip(id("scrim"), "the panel covers the whole screen, no scrim to press"); return; }
    const inside = await ev((l) => { const a = window.__box(window.__sheetParts(l).panel); return { x: (a.l + a.r) / 2, y: a.t + (a.b - a.t) * 0.6 }; }, spec.layer);
    await drag(inside, p);
    await sleep(800);
    const stayed = (await sheetState(spec.layer)).open;
    let closedByScrim = false;
    if (stayed) { await tapAt(p.x, p.y); closedByScrim = !!(await sheetGone(spec.layer, 5000)); }
    await verdict(id("scrim"), stayed && closedByScrim, `press that began inside the panel and ended on the scrim (${Math.round(p.x)},${Math.round(p.y)}, ${p.at}): sheet ${stayed ? "stayed open" : "CLOSED"}; press on the scrim: ${stayed ? (closedByScrim ? "closed" : "did NOT close") : "not tried"}`);
  });

  // ---- focus on open ----
  await step("focus", async () => {
    await ensureClosed(spec);
    if (!(await openByTap(spec))) throw new Error("the sheet did not open");
    await sleep(500);
    const f = await ev((l) => {
      const { s, dialog } = window.__sheetParts(l);
      const a = window.__active();
      const af = s.querySelector("[autofocus]");
      return { desc: window.__desc(a), inside: window.__within(a, s), isDialog: !!a && a.localName === "dialog", field: !!a && (/^(input|textarea)$/.test(a.localName) || a.isContentEditable), onAutofocus: !!af && window.__within(a, af), hasAutofocus: !!af, coarse: matchMedia("(hover: none) and (pointer: coarse)").matches };
    }, spec.layer);
    // The toolkit decides "touch" by (hover: none) and (pointer: coarse); a touch cell must report that, or this check would test the wrong thing.
    const ok = f.inside && (f.coarse ? f.isDialog && !f.field : f.hasAutofocus ? f.onAutofocus : f.isDialog) && f.coarse === cell.size.touch;
    await verdict(id("focus"), ok, `(hover: none) and (pointer: coarse) = ${f.coarse} in this ${cell.size.touch ? "touch" : "mouse"} cell; focus is on ${f.desc} (${f.inside ? "inside" : "OUTSIDE"} the sheet${f.isDialog ? ", the sheet itself" : ""}${f.field ? ", a TEXT FIELD" : ""}); ${f.hasAutofocus ? `the content has an autofocus element and ${f.onAutofocus ? "focus is on it" : "focus is NOT on it"}` : "no autofocus element"}; wanted: ${f.coarse ? "the sheet itself, no field" : f.hasAutofocus ? "the autofocus element" : "the sheet itself"}`);
  });

  // ---- Tab and Shift+Tab stay inside ----
  await step("trap", async () => {
    await ensureOpen(spec);
    const count = await ev((l) => {
      const { s } = window.__sheetParts(l);
      const sel = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), audio[controls], video[controls]';
      return new Set([...window.__deep(s, sel), ...window.__deep(s.shadowRoot, sel)].filter((e) => window.__shown(e))).size;
    }, spec.layer);
    const n = Math.min(count * 2 + 6, 80); // two rounds and a few more: a hand-off to the document needs room to come back
    const walk = async (key) => {
      await ev(() => { window.__seen = new Set(); });
      let wrapped = false;
      let outside = null;
      let cameBack = false;
      const handoffs = []; // presses after which focus sat on the document itself (a native modal <dialog> hands Tab over to the browser's own UI; Home Assistant's dialog does the same)
      for (let i = 0; i < n; i += 1) {
        await page.keyboard.press(key);
        const r = await ev((l) => { const { s } = window.__sheetParts(l); const a = window.__active(); const again = window.__seen.has(a); window.__seen.add(a); return { inside: window.__within(a, s), again, desc: window.__desc(a), doc: !a || a === document.body || a === document.documentElement }; }, spec.layer);
        if (!r.inside && r.doc) { handoffs.push(i + 1); continue; }
        if (!r.inside) { outside = `after ${i + 1} ${key}: focus on the PAGE element ${r.desc}`; break; }
        if (handoffs.length) cameBack = true;
        if (r.again) wrapped = true;
      }
      return { wrapped, outside, cameBack, handoffs, distinct: await ev(() => window.__seen.size) };
    };
    const fwd = await walk("Tab");
    const bwd = await walk("Shift+Tab");
    const wrapNeeded = n >= count + 2;
    // The rule (parity with Home Assistant's own dialog, measured on the installed 1.1.0): a control of the PAGE behind never takes focus; focus may pass over the
    // document itself (the browser's UI) after the last control, and the next press must bring it back into the sheet.
    const bad = (x) => x.outside ?? (x.handoffs.length && !x.cameBack ? "focus left the sheet for the document and did not come back" : null);
    const ok = !bad(fwd) && !bad(bwd) && (!wrapNeeded || (fwd.wrapped && bwd.wrapped));
    const say = (x) => bad(x) ?? `page behind never reached, ${x.distinct} distinct control(s), ${x.handoffs.length ? `focus passed over the document (browser UI) after press ${x.handoffs.join(", ")} and came back` : "wrapped round inside the sheet"}`;
    await verdict(id("trap"), ok, `${count} tabbable control(s); ${n} x Tab: ${say(fwd)}; ${n} x Shift+Tab: ${say(bwd)}`);
  });

  // ---- placement, close button ----
  await onlyNative("geometry", async () => {
    await ensureOpen(spec);
    await setInsets(ZERO_INSETS);
    await sleep(300);
    const g = await ev((l) => {
      const P = window.__sheetParts(l);
      const pc = getComputedStyle(P.panel);
      // The dialog fills the layout viewport, which is the window minus a classic page scrollbar (this Chromium draws one even in a phone size; a phone has overlay bars).
      return { vw: document.documentElement.clientWidth, vh: document.documentElement.clientHeight, dialog: window.__box(P.dialog), panel: window.__box(P.panel), handle: window.__box(P.handle), close: window.__box(P.close), radii: [pc.borderTopLeftRadius, pc.borderTopRightRadius, pc.borderBottomRightRadius, pc.borderBottomLeftRadius].map(parseFloat) };
    }, spec.layer);
    const { vw, vh } = g;
    const [tl, tr, br, bl] = g.radii;
    const bad = [];
    if (!(near(g.dialog.l, 0) && near(g.dialog.t, 0) && near(g.dialog.w, vw) && near(g.dialog.h, vh))) bad.push(`dialog ${Math.round(g.dialog.w)}x${Math.round(g.dialog.h)} does not cover the ${vw}x${vh} viewport`);
    if (!(g.close.w >= 44 && g.close.h >= 44)) bad.push(`close button ${Math.round(g.close.w)}x${Math.round(g.close.h)} < 44`);
    if (!(g.close.l >= g.panel.l - 0.5 && g.close.r <= g.panel.r + 0.5 && g.close.t >= g.panel.t - 0.5 && g.close.b <= g.panel.b + 0.5 && g.close.r <= vw && g.close.t >= 0)) bad.push("close button not inside the panel/screen");
    if (mode === "bottom") {
      if (!(near(g.panel.l, 0) && near(g.panel.r, vw) && near(g.panel.b, vh) && g.panel.t > 0)) bad.push(`not a full-width bottom sheet (${Math.round(g.panel.l)}..${Math.round(g.panel.r)} x ${Math.round(g.panel.t)}..${Math.round(g.panel.b)} in ${vw}x${vh})`);
      if (g.panel.h > vh * 0.94 + 1.5) bad.push(`taller than 94% of the screen (${Math.round(g.panel.h)} of ${vh})`);
      if (!(g.handle && g.handle.h > 0)) bad.push("no handle shown");
      if (!(tl > 0 && tr > 0 && br === 0 && bl === 0)) bad.push(`corner radii ${g.radii.join("/")} (want rounded on top only)`);
    } else if (mode === "side") {
      if (!(near(g.panel.r, vw) && near(g.panel.t, 0) && near(g.panel.b, vh))) bad.push(`not a full-height pane against the right edge (${Math.round(g.panel.l)}..${Math.round(g.panel.r)} x ${Math.round(g.panel.t)}..${Math.round(g.panel.b)} in ${vw}x${vh})`);
      if (!near(g.panel.w, Math.min(520, 0.42 * w), 2)) bad.push(`pane width ${Math.round(g.panel.w)} (want ${Math.round(Math.min(520, 0.42 * w))}: min(520px, 42vw), vw = the window width ${w})`);
      if (g.handle && g.handle.h > 0) bad.push("a handle is shown on a side pane");
      if (!(tl > 0 && bl > 0 && tr === 0 && br === 0)) bad.push(`corner radii ${g.radii.join("/")} (want rounded on the inner side only)`);
    } else {
      if (!(near(g.panel.w, Math.min(640, vw - 48), 2) && near((g.panel.l + g.panel.r) / 2, vw / 2) && near((g.panel.t + g.panel.b) / 2, vh / 2, 2))) bad.push(`not a centred dialog (${Math.round(g.panel.l)}..${Math.round(g.panel.r)} x ${Math.round(g.panel.t)}..${Math.round(g.panel.b)} in ${vw}x${vh})`);
      if (g.handle && g.handle.h > 0) bad.push("a handle is shown on a centred dialog");
      if (!(tl > 0 && tr > 0 && br > 0 && bl > 0)) bad.push(`corner radii ${g.radii.join("/")} (want all rounded)`);
    }
    await verdict(id("geometry"), bad.length === 0, `${w}x${h} (viewport ${vw}x${vh}) -> ${mode}: panel ${Math.round(g.panel.l)}..${Math.round(g.panel.r)} x ${Math.round(g.panel.t)}..${Math.round(g.panel.b)} (${Math.round(g.panel.w)}x${Math.round(g.panel.h)}), handle ${g.handle && g.handle.h > 0 ? "shown" : "hidden"}, close ${Math.round(g.close.w)}x${Math.round(g.close.h)} at ${Math.round(g.close.l)},${Math.round(g.close.t)}${bad.length ? `; ${bad.join("; ")}` : ""}`);
    await shotTo(`${cell.theme.name === "Neumorphism" ? "flat-light" : "glass-dark"}-${w}x${h}-sheet-${spec.prefix}`).catch(() => undefined);
  });

  // ---- safe-area insets (Chrome's Emulation.setSafeAreaInsetsOverride on the real page) ----
  await onlyNative("safe", async () => {
    await ensureOpen(spec);
    const measure = () => ev((l) => {
      const P = window.__sheetParts(l);
      const num = (e, k) => parseFloat(getComputedStyle(e)[k]);
      return { vw: document.documentElement.clientWidth, vh: document.documentElement.clientHeight, panel: window.__box(P.panel), close: window.__box(P.close), body: window.__box(P.body), footer: window.__box(P.footer), foot: P.panel.classList.contains("has-footer"),
        padL: num(P.panel, "paddingLeft"), padR: num(P.panel, "paddingRight"), padT: num(P.panel, "paddingTop"), bodyB: num(P.body, "paddingBottom"), footB: num(P.footer, "paddingBottom") };
    }, spec.layer);
    await setInsets(ZERO_INSETS);
    await sleep(300);
    const z = await measure();
    await setInsets(INSETS);
    await sleep(500);
    const m = await measure();
    await shotTo(`${cell.theme.name === "Neumorphism" ? "flat-light" : "glass-dark"}-${w}x${h}-safe-${spec.prefix}`).catch(() => undefined);
    await setInsets(ZERO_INSETS);
    await sleep(300);
    const back0 = await measure();
    const bottomOf = (x) => (x.foot ? x.footB : x.bodyB);
    const bad = [];
    const grew = (name, was, now, by) => { if (!near(now - was, by)) bad.push(`${name} padding ${was}->${now} (want +${by})`); };
    if (mode !== "centred") grew(`${m.foot ? "footer" : "body"} bottom`, bottomOf(z), bottomOf(m), INSETS.bottom);
    if (mode === "bottom") { grew("panel left", z.padL, m.padL, INSETS.left); grew("panel right", z.padR, m.padR, INSETS.right); }
    if (mode === "side") { grew("panel top", z.padT, m.padT, INSETS.top); grew("panel right", z.padR, m.padR, INSETS.right); }
    // Whatever the mode: nothing the user must reach sits inside a safe area, and the content can scroll clear of the bottom one.
    if (!(m.close.t >= INSETS.top - 0.5 && m.close.r <= m.vw - INSETS.right + 0.5 && m.close.l >= INSETS.left - 0.5 && m.close.b <= m.vh - INSETS.bottom + 0.5)) bad.push(`close button ${Math.round(m.close.l)},${Math.round(m.close.t)}..${Math.round(m.close.r)},${Math.round(m.close.b)} reaches into a safe area`);
    const contentBottom = m.foot ? m.footer.b - m.footB : m.body.b - m.bodyB;
    if (mode !== "centred" && contentBottom > m.vh - INSETS.bottom + 0.5) bad.push(`${m.foot ? "footer" : "body"} content ends at ${Math.round(contentBottom)}, below the bottom inset line ${m.vh - INSETS.bottom}`);
    if (mode === "centred" && !(m.panel.t >= INSETS.top && m.panel.b <= m.vh - INSETS.bottom && m.panel.l >= INSETS.left && m.panel.r <= m.vw - INSETS.right)) bad.push("the centred panel reaches into a safe area");
    if (!near(bottomOf(back0), bottomOf(z)) || !near(back0.padR, z.padR)) bad.push(`after setting the insets back to 0 the padding stayed (${bottomOf(back0)} / ${back0.padR})`);
    await verdict(id("safe"), bad.length === 0, `insets T${INSETS.top} B${INSETS.bottom} L${INSETS.left} R${INSETS.right} (${mode}): ${m.foot ? "footer" : "body"} bottom padding ${bottomOf(z)} -> ${bottomOf(m)}, panel padding L ${z.padL}->${m.padL} R ${z.padR}->${m.padR} T ${z.padT}->${m.padT}, close button ${Math.round(m.close.l)},${Math.round(m.close.t)}..${Math.round(m.close.r)},${Math.round(m.close.b)}${bad.length ? `; ${bad.join("; ")}` : ""}`);
  });

  // ---- the theme, switched live with the sheet open ----
  await onlyNative("theme", async () => {
    await ensureOpen(spec);
    const paint = () => ev((l) => {
      const P = window.__sheetParts(l);
      const mk = (css) => { const d = document.createElement("div"); d.style.cssText = `position:fixed;left:-9999px;top:0;width:10px;height:10px;box-sizing:border-box;${css}`; document.body.append(d); return d; };
      // What the Home Assistant theme's own variables say the sheet should look like (the fallback chains are the toolkit's documented contract).
      const panelRef = mk("border:1px solid var(--ha-card-border-color, var(--divider-color));color:var(--primary-text-color);background:var(--ha-dialog-surface-background, var(--mdc-theme-surface, var(--card-background-color)));backdrop-filter:var(--ha-dialog-surface-backdrop-filter, none)");
      const scrimRef = mk("background:var(--primary-background-color);backdrop-filter:var(--ha-dialog-scrim-backdrop-filter, none)");
      const canvas = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
      const rgba = (css) => { canvas.clearRect(0, 0, 1, 1); canvas.fillStyle = "#000"; canvas.fillStyle = css; canvas.fillRect(0, 0, 1, 1); return [...canvas.getImageData(0, 0, 1, 1).data]; };
      const pc = getComputedStyle(P.panel), sc = getComputedStyle(P.scrim), rc = getComputedStyle(panelRef), rs = getComputedStyle(scrimRef);
      const title = P.s.shadowRoot.querySelector("#title") ?? P.panel;
      const dimEl = P.s.shadowRoot.querySelector(".dim");
      const scrimA = rgba(sc.backgroundColor), scrimW = rgba(rs.backgroundColor);
      const isFilter = (v) => !!v && v !== "none";
      const level = /^brightness\(([\d.]+)\)$/.exec(rs.backdropFilter);
      const out = {
        now: { bg: `${pc.backgroundColor} ${pc.backgroundImage}`.trim(), bgImage: pc.backgroundImage, blur: pc.backdropFilter, edge: pc.borderTopColor, ink: getComputedStyle(title).color, scrimBlur: sc.backdropFilter, scrim: scrimA.join(",") },
        want: { bg: `${rc.backgroundColor} ${rc.backgroundImage}`.trim(), bgColor: rc.backgroundColor, blur: rc.backdropFilter, edge: rc.borderTopColor, ink: rc.color, scrimBlur: rs.backdropFilter },
        scrimOk: [0, 1, 2].every((i) => Math.abs(scrimA[i] - scrimW[i]) <= 3) && Math.abs(scrimA[3] / 255 - 0.7) <= 0.02,
        // the dim layer (a black sibling that darkens the page for a scrim filter that is only brightness(x)) and the flat frost (a panel blur that only sees the scrim)
        hasDimLayer: !!dimEl,
        dimOn: !!dimEl && P.dialog.hasAttribute("data-dim"),
        dimAlpha: dimEl ? rgba(getComputedStyle(dimEl).backgroundColor)[3] / 255 : null,
        frostOn: P.dialog.hasAttribute("data-flat-frost"),
        wantLevel: level ? Number(level[1]) : null,
        wantFrost: !!dimEl && isFilter(rs.backdropFilter) && isFilter(rc.backdropFilter),
        open: P.s.hasAttribute("open"), nonce: window.__nonce,
      };
      panelRef.remove(); scrimRef.remove();
      return out;
    }, spec.layer);
    // What "follows the theme" means for the three things the toolkit draws by the cheap route (see lucent-ha sheet-model.ts dialogLook): a scrim filter that is only
    // brightness(x) is a black layer of opacity 1 - x and the scrim itself has no filter; a panel blur next to a scrim filter is the panel's colour over the scrim's, no blur.
    // A bundle without the .dim layer (older toolkit) is held to plain equality with the theme's variables.
    const scrimFollows = (p) => (p.hasDimLayer && p.wantLevel !== null && p.wantLevel >= 0 && p.wantLevel <= 1
      ? p.dimOn && p.now.scrimBlur === "none" && Math.abs(p.dimAlpha - (1 - p.wantLevel)) <= 0.01
      : !p.dimOn && p.now.scrimBlur === p.want.scrimBlur);
    const panelFollows = (p) => (p.wantFrost
      ? p.frostOn && p.now.blur === "none" && p.now.bgImage.includes(p.want.bgColor)
      : !p.frostOn && p.now.bg === p.want.bg && p.now.blur === p.want.blur);
    const agrees = (p) => p.scrimOk && p.now.edge === p.want.edge && p.now.ink === p.want.ink && scrimFollows(p) && panelFollows(p);
    const states = [];
    const nonce0 = (await paint()).nonce;
    const settle = async (t0) => { let p = await paint(); while (!agrees(p) && Date.now() - t0 < 2500) { await sleep(50); p = await paint(); } return { p, ms: Date.now() - t0 }; };
    for (const t of CYCLE) {
      const t0 = Date.now();
      await wearTheme(t, 0);
      const { p, ms } = await settle(t0);
      states.push({ key: t.key, ms, p, ok: agrees(p) });
      await sleep(250);
      states[states.length - 1].settled = agrees(await paint());
    }
    // The installed glass theme ("Caule Black Blue Glass") sets no dialog blur at all, so a theme that asks for blur is shown with stand-ins: dialog variables set on
    // the page (not saved anywhere) while the glass theme is worn, then taken off again. A: only the panel blurs. B: only the scrim blurs. C: both (the panel then
    // paints flat, by design). Each is followed at once and undone at once.
    const VARS = ["--ha-dialog-surface-backdrop-filter", "--ha-dialog-scrim-backdrop-filter"];
    const setVars = (vars) => ev(([names, values]) => { names.forEach((n, i) => { if (values[i] === null) document.documentElement.style.removeProperty(n); else document.documentElement.style.setProperty(n, values[i]); }); }, [VARS, vars]);
    const probes = [];
    try {
      await wearTheme(THEME_BY_KEY["glass-dark"], 0);
      for (const [name, vars, want] of [
        ["A panel blur only", ["blur(12px)", "none"], (p) => p.now.blur === "blur(12px)" && p.now.scrimBlur === "none" && !p.dimOn],
        ["B scrim blur only", ["none", "blur(4px)"], (p) => p.now.scrimBlur === "blur(4px)" && !p.dimOn && p.now.blur === "none"],
        ["C both", ["blur(12px)", "blur(4px)"], (p) => p.now.scrimBlur === "blur(4px)" && (p.hasDimLayer ? p.frostOn && p.now.blur === "none" : p.now.blur === "blur(12px)")],
      ]) {
        await setVars(vars);
        const on = await settle(Date.now());
        await setVars([null, null]);
        const off = await settle(Date.now());
        probes.push({ name, on, off, shapeOk: want(on.p) && agrees(on.p), backOk: agrees(off.p) });
      }
    } finally {
      await setVars([null, null]).catch(() => undefined);
      await wearTheme(cell.theme, 600);
    }
    const labels = states.map((s) => `${s.key}: ${s.ok ? `followed in ${s.ms} ms` : "DID NOT FOLLOW"}${s.settled ? "" : " (then drifted)"}, bg ${s.p.now.bg.slice(0, 44)}, ink ${s.p.now.ink}, edge ${s.p.now.edge}, blur ${s.p.now.blur}${s.p.frostOn ? " (flat frost)" : ""} (theme asks ${s.p.want.blur}), scrim ${s.p.dimOn ? `dim layer ${s.p.dimAlpha.toFixed(2)} (theme asks ${s.p.want.scrimBlur})` : s.p.now.scrimBlur} + rgba(${s.p.now.scrim})${s.p.scrimOk ? "" : " != the theme's primary-background at 70%"}`);
    const bad = [];
    for (const s of states) { if (!s.ok || !s.settled) bad.push(`${s.key} not followed`); if (s.ms > 1000) bad.push(`${s.key} took ${s.ms} ms`); if (!s.p.open) bad.push("the sheet closed"); if (s.p.nonce !== nonce0) bad.push("the page reloaded"); }
    for (let i = 1; i < states.length; i += 1) { const a = states[i - 1].p.want, b = states[i].p.want; if (a.bg === b.bg && a.ink === b.ink && a.edge === b.edge) bad.push(`the theme switch ${states[i - 1].key} -> ${states[i].key} changed none of the theme's colours (the check would prove nothing)`); }
    if (states[0].p.now.bg !== states[3].p.now.bg || states[0].p.now.ink !== states[3].p.now.ink) bad.push("back on flat-light the colours differ from the first time (stale)");
    for (const pr of probes) { if (!pr.shapeOk) bad.push(`stand-in ${pr.name}: panel blur ${pr.on.p.now.blur}, scrim blur ${pr.on.p.now.scrimBlur}, dim ${pr.on.p.dimOn}, frost ${pr.on.p.frostOn}`); if (!pr.backOk) bad.push(`stand-in ${pr.name}: not undone`); if (pr.on.ms > 1000 || pr.off.ms > 1000) bad.push(`stand-in ${pr.name} took ${pr.on.ms}/${pr.off.ms} ms`); }
    await verdict(id("theme"), bad.length === 0, `${labels.join(" | ")} | blur stand-ins on the glass theme: ${probes.map((pr) => `${pr.name}: panel ${pr.on.p.now.blur}${pr.on.p.frostOn ? " (flat frost)" : ""}, scrim ${pr.on.p.now.scrimBlur} in ${pr.on.ms} ms, undone in ${pr.off.ms} ms`).join("; ")}${bad.length ? `; ${[...new Set(bad)].join("; ")}` : ""}`);
    await shotTo(`${cell.theme.name === "Neumorphism" ? "flat-light" : "glass-dark"}-${w}x${h}-theme-${spec.prefix}`).catch(() => undefined);
  });

  // ---- how dark the scrim makes the page (pixels of the page behind, closed vs open) ----
  // Home Assistant's scrim is `backdrop-filter: brightness(68%)` under the theme's scrim colour. The toolkit may draw it as a black layer instead (.dim); either way the
  // picture must be the same: open pixel = scrim colour over (x * closed pixel), per channel, within 2/255.
  await onlyNative("dim", async () => {
    const measure = async () => {
      await ensureClosed(spec);
      await ensureOpen(spec);
      await sleep(900); // the enter motion is over
      // A strip of a known bright colour along the top edge of the page (test-only DOM, in the page, behind the dialog): the real page may be near-black (the glass theme),
      // where "darker" cannot be measured. It is the "page behind" the scrim for this check and is removed again below.
      await ev(() => { const s = document.createElement("div"); s.id = "__sca-strip"; s.style.cssText = "position:fixed;left:0;top:0;width:100%;height:12px;background:rgb(220,150,80);z-index:2147483000;pointer-events:none"; document.body.append(s); });
      const info = await ev((l) => {
        const P = window.__sheetParts(l);
        const a = window.__box(P.panel);
        const W = document.documentElement.clientWidth;
        const ref = document.createElement("div");
        ref.style.cssText = "position:fixed;left:-9999px;width:10px;height:10px;background:var(--primary-background-color);backdrop-filter:var(--ha-dialog-scrim-backdrop-filter, none)";
        document.body.append(ref);
        const rs = getComputedStyle(ref);
        const canvas = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
        const rgba = (css) => { canvas.clearRect(0, 0, 1, 1); canvas.fillStyle = "#000"; canvas.fillStyle = css; canvas.fillRect(0, 0, 1, 1); return [...canvas.getImageData(0, 0, 1, 1).data]; };
        const colour = rgba(rs.backgroundColor);
        const filter = rs.backdropFilter;
        ref.remove();
        const level = /^brightness\(([\d.]+)\)$/.exec(filter);
        const alpha = rgba(getComputedStyle(P.scrim).backgroundColor)[3] / 255;
        const edge = a.l >= 60 ? a.l : W; // side pane: the scrim is the strip left of the panel; else the whole top edge
        return { pts: [0.3, 0.5, 0.7].map((f) => ({ x: Math.round(edge * f), y: 6 })), colour, alpha, filter, level: level ? Number(level[1]) : (filter === "none" ? 1 : null), W, dim: P.dialog.hasAttribute("data-dim") };
      }, spec.layer);
      const band = { x: 0, y: 0, width: info.W, height: 12 };
      const open = (await page.screenshot({ type: "png", clip: band })).toString("base64");
      await closeBy(spec, "escape");
      await sleep(600);
      const closed = (await page.screenshot({ type: "png", clip: band })).toString("base64");
      await ev(() => document.getElementById("__sca-strip")?.remove());
      const px = await ev(async ([a, b, pts]) => {
        const read = async (b64) => {
          const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
          const c = document.createElement("canvas"); c.width = bmp.width; c.height = bmp.height;
          const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(bmp, 0, 0);
          return pts.map((p) => { const d = g.getImageData(Math.max(0, p.x - 1), p.y - 1, 3, 3).data; const m = [0, 0, 0]; for (let i = 0; i < 9; i += 1) for (let k = 0; k < 3; k += 1) m[k] += d[i * 4 + k] / 9; return m; });
        };
        return { open: await read(a), closed: await read(b) };
      }, [open, closed, info.pts]);
      return { info, px };
    };
    let m = await measure();
    if (m.info.level === null) { skip(id("dim"), `the theme's scrim filter is ${m.info.filter}: not a brightness filter, so there is no darkness to compare`); return; }
    const errors = (r) => r.px.open.map((o, i) => { const c = r.px.closed[i]; return Math.max(...[0, 1, 2].map((k) => Math.abs(o[k] - (r.info.alpha * r.info.colour[k] + (1 - r.info.alpha) * r.info.level * c[k])))); });
    let errs = errors(m);
    if (Math.max(...errs) > 2) { m = await measure(); errs = errors(m); } // the page behind may have changed between the two pictures: once more
    const worst = Math.max(...errs);
    const sample = (r, i) => `(${r.info.pts[i].x},${r.info.pts[i].y}) page ${r.px.closed[i].map(Math.round).join(",")} -> sheet ${r.px.open[i].map(Math.round).join(",")}`;
    await verdict(id("dim"), worst <= 2, `theme scrim: brightness ${m.info.level} under rgba(${m.info.colour.slice(0, 3).join(",")},${m.info.alpha.toFixed(2)}); drawn ${m.info.dim ? "as a black .dim layer" : "as the scrim's own backdrop filter"}; 3 points of the page behind: ${[0, 1, 2].map((i) => sample(m, i)).join("; ")}; worst difference from the expected colour ${worst.toFixed(1)}/255 (limit 2)`);
    await shotTo(`${cell.theme.name === "Neumorphism" ? "flat-light" : "glass-dark"}-${w}x${h}-dim-${spec.prefix}-closed`).catch(() => undefined);
  });

  // ---- the scrim and the panel fade in and out (no pop) ----
  await onlyNative("fade", async () => {
    const run = async (open) => {
      await ensureClosed(spec);
      if (!open) { await ensureOpen(spec); await sleep(900); }
      await ev((l) => {
        const st = (window.__fade = { s: [], on: true, t0: performance.now() });
        const tick = () => {
          if (!st.on) return;
          const P = window.__sheetParts(l); // looked up every frame: a closed species sheet is not rendered at all
          if (P.dialog) {
            const dimEl = P.s.shadowRoot.querySelector(".dim");
            const dimShown = dimEl && getComputedStyle(dimEl).display !== "none";
            st.s.push({ t: Math.round(performance.now() - st.t0), open: P.dialog.open, scrim: +getComputedStyle(P.scrim).opacity, dim: dimShown ? +getComputedStyle(dimEl).opacity : null, panel: +getComputedStyle(P.panel).opacity });
          }
          requestAnimationFrame(tick);
        };
        tick();
      }, spec.layer);
      if (open) await tap(await spec.opener()); else await page.keyboard.press("Escape");
      await sleep(800);
      return ev(() => { window.__fade.on = false; return window.__fade.s; });
    };
    const judge = (samples, entering) => {
      const open = samples.filter((s) => s.open);
      const mid = (key) => open.filter((s) => s[key] !== null && s[key] > 0.03 && s[key] < 0.97).length;
      const dimUsed = open.some((s) => s.dim !== null);
      const out = open.length ? { n: open.length, ms: open[open.length - 1].t - open[0].t, first: open[0], last: open[open.length - 1], scrim: mid("scrim"), panel: mid("panel"), dim: dimUsed ? mid("dim") : null } : null;
      const bad = [];
      if (!out) return { bad: ["no frame with the dialog open"], out };
      if (out.scrim < 1) bad.push("the scrim does not fade (no in-between frame)");
      if (out.panel < 1) bad.push("the panel does not fade (no in-between frame)");
      if (dimUsed && out.dim < 1) bad.push("the dim layer does not fade (no in-between frame)");
      if (entering && !(out.first.scrim <= 0.9 && (out.first.dim === null || out.first.dim <= 0.9))) bad.push(`first frame already at scrim ${out.first.scrim}${out.first.dim === null ? "" : `, dim ${out.first.dim}`} (a pop)`);
      if (entering && !(out.last.scrim >= 0.99 && out.last.panel >= 0.99)) bad.push("did not reach full opacity");
      if (open.some((s) => s.dim !== null && Math.abs(s.dim - s.scrim) > 0.08)) bad.push("the dim layer and the scrim fade out of step");
      return { bad, out };
    };
    const say = (j) => (j.out ? `${j.out.n} frames over ${j.out.ms} ms, scrim ${j.out.first.scrim}->${j.out.last.scrim} (${j.out.scrim} in between), panel ${j.out.first.panel}->${j.out.last.panel} (${j.out.panel} in between), dim ${j.out.dim === null ? "not used" : `${j.out.dim} in between`}` : "no frames");
    let enter = judge(await run(true), true);
    let leave = judge(await run(false), false);
    if (enter.bad.length || leave.bad.length) { enter = judge(await run(true), true); leave = judge(await run(false), false); } // a loaded host drops frames: once more
    const bad = [...enter.bad.map((b) => `enter: ${b}`), ...leave.bad.map((b) => `leave: ${b}`)];
    await ensureClosed(spec);
    await verdict(id("fade"), bad.length === 0, `enter: ${say(enter)}; leave: ${say(leave)}${bad.length ? `; ${bad.join("; ")}` : ""}`);
  });
  await ensureClosed(spec);

  // ---- the page behind never moves ----
  await step("lock", async () => {
    let max = await ev(() => window.__max());
    let spacer = "";
    if (max < 60) {
      // A page that cannot scroll (the visit page on a phone) proves nothing about the lock: give it 1500 px of empty room for the length of this check (test-only DOM, removed again).
      await ev(() => { const s = document.createElement("div"); s.id = "__sca-spacer"; s.style.cssText = "height:1500px;width:1px;pointer-events:none"; (window.__scroller().element ?? document.body).append(s); });
      await sleep(300);
      max = await ev(() => window.__max());
      spacer = ` (the page was too short to scroll, so a 1500 px empty spacer was added for this check; scrollable ${Math.round(max)} px)`;
      if (max < 60) { await ev(() => document.getElementById("__sca-spacer")?.remove()); skip(id("lock"), `the page scrolls only ${Math.round(max)} px at this size even with a spacer`); return; }
    }
    await ev((t) => window.__scroller().scrollTo(t), Math.min(300, Math.floor(max)));
    await sleep(500);
    const S = await ev(() => window.__top());
    const moved = [];
    const watch = async (what) => { await sleep(220); const t = await ev(() => window.__top()); if (Math.abs(t.page - S.page) > 1 || Math.abs(t.win - S.win) > 1) moved.push(`${what}: ${S.page} -> ${t.page} (window ${t.win})`); };
    if (!(await openByKeyboard(spec))) throw new Error("the sheet did not open");
    await sleep(600);
    await watch("opening");
    const aim = () => ev((l) => {
      const P = window.__sheetParts(l);
      const c = (b) => ({ x: (b.l + b.r) / 2, y: (b.t + b.b) / 2 });
      const a = window.__box(P.panel);
      const scrim = a.t >= 30 ? { x: innerWidth / 2, y: Math.max(8, a.t / 2) } : a.l >= 30 ? { x: a.l / 2, y: innerHeight / 2 } : innerWidth - a.r >= 30 ? { x: a.r + (innerWidth - a.r) / 2, y: innerHeight / 2 } : null;
      return { scrim, head: c(window.__box(P.titles)), body: c(window.__box(P.body)), bodyTop: P.body.scrollTop, bodyRange: P.body.scrollHeight - P.body.clientHeight };
    }, spec.layer);
    const bodyTop = () => ev((l) => window.__sheetParts(l).body.scrollTop, spec.layer);
    const at = await aim();
    const wheel = async (where, p, deltas) => { await page.mouse.move(p.x, p.y); for (const d of deltas) { await page.mouse.wheel(0, d); await sleep(60); } await watch(`wheel over ${where}`); };
    if (at.scrim) await wheel("the scrim", at.scrim, [900, 900, -900, 400]);
    await wheel("the header", at.head, [700, 700, -700, 300]);
    await wheel("the body", at.body, [600, 600, 600, -300]);
    const afterBody = await bodyTop();
    await wheel("the body (to its end and beyond)", at.body, [3000, 3000, 3000, 3000, 3000]);
    const atEnd = await bodyTop();
    await wheel("the body (back to the top, then past it)", at.body, [-3000, -3000, -3000, -3000, -3000]);
    const keys = ["PageDown", "PageUp", "End", "Home", "ArrowDown", "ArrowUp", "Space", "Shift+Space"];
    const pressKeys = async (label) => {
      for (const k of keys) {
        const field = await ev(() => { const a = window.__active(); return !!a && (/^(input|textarea)$/.test(a.localName) || a.isContentEditable); });
        if (field && /Space/.test(k)) continue; // a space typed into the search field is the field's, not a scroll
        await page.keyboard.press(k);
        await sleep(120);
        await watch(`${k} (${label})`);
      }
    };
    await pressKeys("focus where the sheet put it");
    await ev((l) => { const P = window.__sheetParts(l); P.dialog.focus({ preventScroll: true }); }, spec.layer);
    await page.keyboard.press("End");
    await sleep(400);
    const keyEnd = await bodyTop();
    await watch("End (focus on the sheet)");
    await pressKeys("focus on the sheet");
    let touched = "mouse size: no finger drags";
    if (cell.size.touch) {
      const drags = [];
      if (at.scrim) drags.push(["the scrim", { x: at.scrim.x, y: at.scrim.y + 25 }, { x: at.scrim.x, y: at.scrim.y - 25 }]);
      drags.push(["the header", { x: at.head.x, y: at.head.y + 20 }, { x: at.head.x, y: at.head.y - 120 }]);
      for (const [where, from, to] of drags) {
        if (!(await sheetState(spec.layer)).open) break;
        await drag(from, to);
        await watch(`finger drag over ${where}`);
      }
      touched = `finger drags up over ${drags.map((d) => d[0]).join(" and ")}`;
    }
    if ((await sheetState(spec.layer)).open) { await page.keyboard.press("Escape"); await sheetGone(spec.layer, 4000); }
    await sleep(600);
    const final = await ev(() => window.__top());
    if (Math.abs(final.page - S.page) > 1 || Math.abs(final.win - S.win) > 1) moved.push(`after closing: ${S.page} -> ${final.page} (window ${final.win})`);
    const scrolls = at.bodyRange > 8;
    if (scrolls && !(afterBody > 0 && atEnd > 0 && keyEnd > 0)) moved.push(`the body did not scroll (wheel ${afterBody}, to end ${atEnd}, End key ${keyEnd} of ${Math.round(at.bodyRange)} px)`);
    await ev(() => document.getElementById("__sca-spacer")?.remove());
    await verdict(id("lock"), moved.length === 0, `page held at ${S.page} px through wheel (scrim, header, body to its end and past it), ${keys.length} keys x 2 focus positions, ${touched}, and after closing it is at ${final.page}${spacer}; the body ${scrolls ? `scrolled (wheel to ${afterBody}, end ${atEnd}, End key ${keyEnd} of ${Math.round(at.bodyRange)} px)` : "has no overflow here (it cannot scroll, so only the page staying put is shown)"}${moved.length ? `; ${moved.slice(0, 4).join("; ")}` : ""}`);
  });

  // ---- focus returns to what opened the sheet ----
  await step("return", async () => {
    const ways = [];
    const badWays = [];
    for (const how of ["escape", "button", "back", "scrim"]) {
      await ensureClosed(spec);
      if (!(await focusOpener(spec))) throw new Error("the opener would not take focus");
      await ev(() => { window.__opener = window.__active(); });
      await page.keyboard.press("Enter");
      if (!(await sheetUp(spec.layer, 8000))) throw new Error(`the sheet did not open (${how})`);
      await sleep(450);
      const gone = await closeBy(spec, how);
      await sleep(350);
      const r = await ev(() => ({ same: window.__active() === window.__opener, connected: !!window.__opener?.isConnected, now: window.__desc(window.__active()), was: window.__desc(window.__opener) }));
      ways.push(`${how}: ${gone ? "" : "sheet NOT closed, "}focus ${r.same ? `back on ${r.was}` : `on ${r.now}, not on ${r.was}${r.connected ? "" : " (gone from the page)"}`}`);
      if (!gone || !r.same) badWays.push(how);
    }
    await verdict(id("return"), badWays.length === 0, ways.join("; "));
  });

  // ---- swipe down (bottom sheet, finger) ----
  await step("swipe", async () => {
    if (!cell.size.touch) { skip(id("swipe"), `${w}x${h} is a mouse size: the swipe is a finger gesture`); return; }
    if (mode !== "bottom") { skip(id("swipe"), `${w}x${h} shows a ${mode === "side" ? "side pane" : "centred dialog"}; only the bottom sheet swipes`); return; }
    await ensureClosed(spec);
    if (!(await openByTap(spec))) throw new Error("the sheet did not open");
    await sleep(700);
    if (!(await isNative())) { skip(id("swipe"), "this sheet is drawn by Home Assistant's dialog"); return; }
    const hb = await ev((l) => window.__box(window.__sheetParts(l).handle), spec.layer);
    const from = { x: (hb.l + hb.r) / 2, y: (hb.t + hb.b) / 2 };
    await drag(from, { x: from.x, y: from.y + 14 });
    await sleep(500);
    const stayed = (await sheetState(spec.layer)).open;
    let gone = false;
    if (stayed) {
      const hb2 = await ev((l) => window.__box(window.__sheetParts(l).handle), spec.layer);
      const f2 = { x: (hb2.l + hb2.r) / 2, y: (hb2.t + hb2.b) / 2 };
      await drag(f2, { x: f2.x, y: f2.y + 180 });
      gone = !!(await sheetGone(spec.layer, 5000));
    }
    await sleep(300);
    const now = await where();
    await verdict(id("swipe"), stayed && gone && now === urlBefore, `a 14 px pull on the handle: ${stayed ? "the sheet stayed open" : "it CLOSED (too easy)"}; a 180 px pull: ${stayed ? (gone ? "closed" : "did NOT close") : "not tried"}; ${now} (was ${urlBefore})`);
  });
  await ensureClosed(spec);
}

// ---- one cell -----------------------------------------------------------------------------------------------------------------------
async function runCell(c) {
  cell = c;
  console.log(`\n# ${c.key}  ${c.size.w}x${c.size.h}  ${c.theme.name}  touch=${c.size.touch} mobile=${c.size.mobile}  load ${load()}`);
  errors.length = 0;
  ignored = 0;
  await emulate(c);
  const group = async (name, fn, ids) => {
    if (ONLY && ONLY !== name) return;
    try { await fn(); } catch (error) {
      for (const id of ids) if (!results.some((r) => r.cell === c.key && r.id === id)) await fail(id, `${name} threw: ${String(error?.message ?? error).split("\n")[0].slice(0, 160)}`);
    }
  };
  const narrow = c.size.w <= 870;
  let heardCandidate = null;

  // ---------------- A: Live ----------------
  await group("live", async () => {
    await open("/kestrel/live", c, () => window.__deep(window.__panel(), "article.camera-tile").length > 0);
    heardCandidate = await findHeard();

    // 1. Live opens
    const bar = () => ev(() => { const b = window.__deep(window.__shell().shadowRoot, ".bar")[0]; return b ? { top: b.getBoundingClientRect().top, text: b.textContent.replace(/\s+/g, " ").trim().slice(0, 60) } : null; });
    const b0 = await bar();
    const max = await ev(() => window.__max());
    if (max < 60) skip("1.pinned", `the Live page scrolls only ${Math.round(max)} px at this size`);
    else {
      const to = Math.min(600, Math.floor(max));
      await ev((t) => window.__scroller().scrollTo(t), to);
      await sleep(500);
      const b1 = await bar();
      const moved = await ev(() => window.__scroller().top);
      await verdict("1.pinned", !!b0 && !!b1 && /Kestrel/.test(b0.text) && Math.abs(b1.top - b0.top) <= 1 && moved >= to - 3, `title "${b0?.text}", bar top ${b0?.top} -> ${b1?.top} after scrolling ${Math.round(moved)}/${to} px`);
      await ev(() => window.__scroller().scrollTo(0));
      await sleep(300);
    }
    const nav = await ev(() => {
      const sh = window.__shell();
      const items = window.__nav().filter((a) => window.__shown(a));
      return { mode: sh.getAttribute("data-lu-nav"), shown: items.length, current: items.filter((a) => a.getAttribute("aria-current") === "page").length, labels: items.map((a) => a.textContent.trim()) };
    });
    await verdict("1.nav", nav.mode === c.size.nav && nav.shown >= 3 && nav.current === 1, `data-lu-nav=${nav.mode} (want ${c.size.nav}), ${nav.shown} destinations visible (${nav.labels.join("/")}), ${nav.current} current`);
    const overflow = await ev(() => ({ sw: document.scrollingElement.scrollWidth, w: innerWidth }));
    await verdict("1.overflow", overflow.sw <= overflow.w, `scrollWidth ${overflow.sw} <= innerWidth ${overflow.w}`);
    const tiles = await ev(() => {
      const t = window.__deep(window.__panel(), "article.camera-tile");
      const lefts = new Set(t.filter((e) => window.__shown(e)).map((e) => Math.round(e.getBoundingClientRect().left)));
      return { count: t.length, columns: lefts.size, live: t.filter((e) => window.__deep(e, "kestrel-live-player").length).length, snap: t.filter((e) => !window.__deep(e, "kestrel-live-player").length).length };
    });
    await verdict("1.tiles", tiles.count >= 1 && tiles.columns >= 1, `${tiles.count} tiles (${tiles.live} live, ${tiles.snap} snapshot-only), ${tiles.columns} column(s)`);
    await sleep(1500);
    await shot("live");

    // 2. HA menu button
    const menuCount = await ev(() => window.__deep(window.__shell().shadowRoot, "button.icon-button").filter((b) => window.__shown(b)).length);
    const hassSide = await ev(() => document.querySelector("home-assistant").hass.dockedSidebar);
    await verdict("2.menu", (menuCount === 1) === narrow && menuCount <= 1, `${menuCount} menu button(s); window ${c.size.w} ${narrow ? "<=" : ">"} 870 so the sidebar is a ${narrow ? "drawer" : "docked"} (dockedSidebar=${hassSide})`);
    if (!narrow || menuCount !== 1) { for (const id of ["2.open", "2.toggle", "2.escape"]) skip(id, "the sidebar is docked at this width, there is no button to tap"); }
    else {
      const menu = () => handle(() => window.__deep(window.__shell().shadowRoot, "button.icon-button").find((b) => window.__shown(b)) ?? null);
      const pos = await tap(await menu());
      const opened = await poll(sidebarVisible, { timeout: 10000 });
      await verdict("2.open", !!opened, `sidebar ${opened ? "visible" : "NOT visible"} after tapping the button at (${Math.round(pos.x)},${Math.round(pos.y)})`);
      await sleep(500);
      const under = await ev(([x, y]) => { let el = document.elementFromPoint(x, y); while (el?.shadowRoot) { const inner = el.shadowRoot.elementFromPoint(x, y); if (!inner || inner === el) break; el = inner; } return el ? el.localName + (el.getAttribute?.("aria-label") ? `[${el.getAttribute("aria-label")}]` : "") : null; }, [pos.x, pos.y]);
      await tapAt(pos.x, pos.y);
      let closed = await poll(async () => !(await sidebarVisible()), { timeout: 2500 });
      let how = "second tap at the same spot";
      if (!closed) { // HA's modal drawer covers the button; a tap outside the drawer is the second tap that is reachable
        await tapAt(c.size.w - 12, c.size.h / 2);
        closed = await poll(async () => !(await sidebarVisible()), { timeout: 4000 });
        how = `same spot is under ${under} (drawer covers the button, drawer did not close); a tap outside the drawer`;
      }
      const path = await where();
      await verdict("2.toggle", !!closed && path.startsWith("/kestrel"), `${how} -> drawer ${closed ? "closed" : "still open"}, at ${path}`);
      if (!path.startsWith("/kestrel")) await open("/kestrel/live", c, () => window.__deep(window.__panel(), "article.camera-tile").length > 0);
      await sleep(400);
      if (!(await sidebarVisible())) await tap(await menu());
      const reopened = await poll(sidebarVisible, { timeout: 4000 });
      await sleep(500);
      await page.keyboard.press("Escape");
      const escaped = await poll(async () => !(await sidebarVisible()), { timeout: 4000 });
      await verdict("2.escape", !!reopened && !!escaped, `reopened=${!!reopened}, Escape -> ${escaped ? "closed" : "still open"}`);
      if (!escaped) await tap(await menu()).catch(() => undefined);
    }

    // 3. Live tile -> focused camera
    const liveTile = () => handle(() => window.__deep(window.__panel(), "article.camera-tile").find((t) => window.__deep(t, "kestrel-live-player").length)?.querySelector("button.camera-focus") ?? null);
    const snapTile = () => handle(() => window.__deep(window.__panel(), "article.camera-tile").find((t) => !window.__deep(t, "kestrel-live-player").length && window.__deep(t, "kestrel-live-picture").length)?.querySelector("button.camera-focus") ?? null);
    const arm = () => ev(() => {
      const tm = (window.__tm = { t0: null, focus: null, pic: null, video: null, kind: null });
      window.addEventListener("pointerdown", () => { tm.t0 = performance.now(); }, { capture: true, once: true });
      clearInterval(window.__tmi);
      const started = performance.now();
      window.__tmi = setInterval(() => {
        const now = performance.now();
        if (tm.t0 === null) return;
        const f = window.__deep(window.__panel(), ".focused-camera")[0];
        if (f && tm.focus === null) tm.focus = now;
        if (f) {
          const p = window.__deep(f, "kestrel-live-player")[0];
          const video = window.__deep(f, "video").find((v) => v.readyState >= 2 && v.videoWidth > 0);
          const poster = p?.shadowRoot?.querySelector("canvas.poster:not([hidden])");
          const img = window.__deep(f, "img").find((i) => i.complete && i.naturalWidth > 0);
          if (video && tm.video === null) tm.video = now;
          if ((video || poster || img) && tm.pic === null) { tm.pic = now; tm.kind = video ? "video" : poster ? "poster" : "image"; }
        }
        if ((tm.pic !== null && (tm.video !== null || now - tm.pic > 4000)) || now - started > 30000) clearInterval(window.__tmi);
      }, 50);
    });
    const focused = () => ev(() => !!window.__deep(window.__panel(), ".focused-camera")[0]);
    const grid = () => ev(() => window.__deep(window.__panel(), "article.camera-tile").filter((t) => window.__shown(t)).length);
    const allCameras = () => handle(() => window.__deep(window.__panel(), 'kestrel-lu-button[label="All cameras"]').find((b) => window.__shown(b)) ?? null);
    if (!(await liveTile())) { for (const id of ["3.focus", "3.picture"]) skip(id, "no camera tile with a live player today"); }
    else {
      await arm();
      await tap(await liveTile());
      const up = await poll(focused, { timeout: 8000 });
      const stats = async (waitMs) => { await poll(() => ev(() => window.__tm.pic !== null), { timeout: waitMs, every: 200 }); await sleep(600); return ev(() => ({ ...window.__tm })); };
      let tm = await stats(25000);
      if (tm.pic !== null && tm.video === null) { await poll(() => ev(() => window.__tm.video !== null), { timeout: 12000, every: 300 }); tm = await ev(() => ({ ...window.__tm })); }
      const ms = (v) => (v === null || tm.t0 === null ? "-" : `${Math.round(v - tm.t0)} ms`);
      await verdict("3.focus", !!up && tm.focus !== null, `.focused-camera appeared ${ms(tm.focus)} after the tap [PROVISIONAL, load ${load()}]`);
      await verdict("3.picture", tm.pic !== null, `first picture (${tm.kind ?? "none"}) ${ms(tm.pic)}, decoded video frame ${ms(tm.video)} [PROVISIONAL, load ${load()}]`);
      await tap(await allCameras());
      const gridBack = await poll(async () => !(await focused()) && (await grid()) >= 1, { timeout: 6000 });
      await verdict("3.back", !!gridBack, `'All cameras' -> grid with ${await grid()} tiles`);
    }
    if (!(await snapTile())) skip("3.snapshot", "no snapshot-only camera tile found");
    else {
      await tap(await snapTile());
      await poll(focused, { timeout: 8000 });
      const shown = await poll(() => ev(() => { const f = window.__deep(window.__panel(), ".focused-camera")[0]; return f ? window.__deep(f, "img").some((i) => i.complete && i.naturalWidth > 0) : false; }), { timeout: 20000, every: 250 });
      await verdict("3.snapshot", !!shown, shown ? "picture loaded in the focused snapshot-only view" : "no loaded <img> in the focused view after 20 s");
      await tap(await allCameras()).catch(() => undefined);
      await poll(async () => !(await focused()), { timeout: 5000 });
    }
  }, ["1.pinned", "1.nav", "1.overflow", "1.tiles", "2.menu", "3.focus", "3.snapshot"]);

  // ---------------- B: Wildlife, sheet, theme, keys, scroll memory ----------------
  await group("wildlife", async () => {
    if (ONLY) await open("/kestrel/live", c, () => window.__deep(window.__panel(), "article.camera-tile").length > 0); // the live group did not run: load the panel
    await gotoTab("wildlife");
    await poll(() => countTiles("button.species-tile"), { timeout: 60000, every: 250 });
    await sleep(1200);
    await expandAllSpecies(); // the grid pages 24 at a time: everything on the page so the filter counts can be compared with the tiles
    const total = await countTiles("button.species-tile");
    const seen = total ? "" : await ev(() => { const v = window.__deep(window.__panel(), 'div[data-view="wildlife"]')[0]; return ` view shows: ${(v?.innerText ?? window.__panel()?.textContent ?? "").replace(/\s+/g, " ").slice(0, 120) || "(empty)"}; ${window.__deep(window.__panel(), "kestrel-lu-state").map((x) => x.getAttribute("kind") + ":" + (x.getAttribute("heading") ?? "")).join(", ")}`; });
    await verdict("4.tiles", total >= 1, `${total} species tiles${seen}`);
    await shot("wildlife");

    const counts = await ev(() => {
      const seg = window.__deep(window.__panel(), "kestrel-lu-segmented")[0];
      if (!seg) return null;
      return [...seg.shadowRoot.querySelectorAll("button.segment")].map((b) => ({ name: b.querySelector(".name")?.textContent.trim(), count: Number(b.querySelector(".meta")?.textContent.replace(/\D/g, "")), checked: b.getAttribute("aria-checked") === "true" }));
    });
    const byName = Object.fromEntries((counts ?? []).map((s) => [s.name, s.count]));
    await verdict("4.filter", !!counts && ["All", "On camera", "Heard"].every((n) => Number.isFinite(byName[n])) && byName.All === total, counts ? `All ${byName.All}, On camera ${byName["On camera"]}, Heard ${byName.Heard}; ${total} tiles shown` : "no filter control");
    const segment = (name) => handle((want) => [...window.__deep(window.__panel(), "kestrel-lu-segmented")[0].shadowRoot.querySelectorAll("button.segment")].find((b) => b.querySelector(".name")?.textContent.trim() === want) ?? null, name);
    const steps = [];
    let cycleOk = !!counts;
    for (const name of ["Heard", "On camera", "All"]) {
      if (!counts) break;
      await tap(await segment(name));
      await sleep(300);
      await expandAllSpecies();
      const want = byName[name];
      const got = await poll(async () => ((await countTiles("button.species-tile")) === want ? want : null), { timeout: 4000 });
      const now = await countTiles("button.species-tile");
      steps.push(`${name}: ${now} tiles (want ${want})`);
      if (got === null) cycleOk = false;
    }
    await verdict("4.cycle", cycleOk, steps.join("; "));
    const badges = await ev(() => window.__deep(window.__panel(), "button.species-tile").map((t) => ({
      label: t.getAttribute("aria-label") ?? "",
      icons: [...new Set(window.__deep(t, 'kestrel-lu-chip[kind="evidence"]').map((chip) => chip.getAttribute("icon")))],
    })));
    const bad = badges.filter((b) => !b.icons.length || b.icons.some((i) => i !== "mdi:video" && i !== "mdi:waveform") || (/ \d+ videos?\b/.test(b.label) && !b.icons.includes("mdi:video")) || (/ \d+ recordings?\b/.test(b.label) && !b.icons.includes("mdi:waveform")));
    const withVideo = badges.filter((b) => b.icons.includes("mdi:video")).length;
    const withWave = badges.filter((b) => b.icons.includes("mdi:waveform")).length;
    await verdict("4.badges", badges.length > 0 && bad.length === 0, `${badges.length} tiles: ${withVideo} with the video icon, ${withWave} with the waveform icon${bad.length ? `; wrong: ${bad.map((b) => b.label.split(".")[0]).join(", ")}` : ""}`);

    // 5. species sheet
    const pick = (await speciesTile("Blue Jay")) ? "Blue Jay" : (await speciesTile("Great Horned Owl")) ? "Great Horned Owl" : null;
    const heardLabel = pick ?? ((await speciesTile(null)) ? (await tileLabel(await speciesTile(null))).split(".")[0] : null);
    if (!heardLabel) { for (const id of ["5.open", "5.sections", "5.play", "5.pause", "5.back", "5.escape", "5.scrim", "9.theme", ...SHEET_IDS["5"]]) skip(id, "no species tile to open"); return; }
    const openSheet = async () => {
      await tap(await speciesTile(heardLabel));
      return sheetUp("species", 8000);
    };
    const rowsReady = () => poll(() => ev(() => { const s = window.__deep(window.__panel(), "kestrel-lu-sheet[layer=species]")[0]; return s ? window.__in(s, "kestrel-lu-audio-list", "button.play:not([disabled])").length : 0; }), { timeout: 25000, every: 250 });
    const sheet = await openSheet();
    const url = await where();
    await verdict("5.open", !!sheet && /[?&]s=/.test(url), `${heardLabel}: lu-sheet open=${sheet?.open}, HA dialog shown=${sheet?.dialog}, ${url}`);
    await rowsReady();
    await sleep(800);
    await shot("species");
    const heads = await ev(() => { const s = window.__deep(window.__panel(), "kestrel-lu-sheet[layer=species]")[0]; return window.__deep(s, "kestrel-lu-section").map((x) => ({ heading: x.heading, shown: window.__shown(x) })); });
    await verdict("5.sections", heads.some((h) => h.heading === "On camera" && h.shown) && heads.some((h) => h.heading === "Heard" && h.shown), `sections: ${heads.map((h) => h.heading).join(" / ") || "none"}`);

    // 9. theme switch is live, sheet stays open
    const other = c.theme.name === "Neumorphism" ? THEMES["glass-dark"] : THEMES["flat-light"];
    const paint = () => ev(() => {
      const bar = window.__deep(window.__shell().shadowRoot, ".bar")[0];
      const text = window.__deep(window.__panel(), "kestrel-species-sheet")[0];
      const target = text ? (window.__deep(text.shadowRoot, ".total strong")[0] ?? window.__deep(text.shadowRoot, "h3")[0]) : null;
      // The bar itself may be transparent: take the first surface behind it that paints a colour or an image.
      const surface = (el) => { for (let n = el; n; n = n.parentElement ?? n.getRootNode()?.host ?? null) { const cs = getComputedStyle(n); if (!/^rgba\(.*, 0\)$|^transparent$/.test(cs.backgroundColor) || cs.backgroundImage !== "none") return `${cs.backgroundColor} ${cs.backgroundImage === "none" ? "" : cs.backgroundImage.slice(0, 60)}`.trim(); } return "none"; };
      const t = target ? getComputedStyle(target) : null;
      return { bar: `${surface(bar)} / ink ${getComputedStyle(bar).color}`, text: t?.color ?? null, nonce: window.__nonce, open: window.__deep(window.__panel(), "kestrel-lu-sheet[layer=species]")[0]?.hasAttribute("open") };
    });
    const p0 = await paint();
    await wearTheme(other);
    await sleep(600);
    const p1 = await paint();
    await wearTheme(c.theme);
    await sleep(600);
    const p2 = await paint();
    await verdict("9.theme", p0.nonce === p1.nonce && p1.open && p1.bar !== p0.bar && p1.text !== p0.text && p2.bar === p0.bar && p2.text === p0.text, `no reload (nonce kept), bar ${p0.bar.slice(0, 60)} -> ${p1.bar.slice(0, 60)}, sheet text ${p0.text} -> ${p1.text}, back to ${p2.bar === p0.bar && p2.text === p0.text ? "the same colours" : "DIFFERENT colours"}`);

    // play / pause
    const ready = await rowsReady();
    if (!ready) { skip("5.play", "the Heard section has no playable row"); skip("5.pause", "the Heard section has no playable row"); }
    else {
      const play = () => handle(() => { const s = window.__deep(window.__panel(), "kestrel-lu-sheet[layer=species]")[0]; return window.__in(s, "kestrel-lu-audio-list", "button.play:not([disabled])")[0] ?? null; });
      const state = () => ev(() => window.__deep(document, "audio").map((a) => ({ paused: a.paused, t: a.currentTime, ready: a.readyState, net: a.networkState, err: a.error?.code ?? null, src: a.currentSrc.split("?")[0].slice(-40) })));
      await tap(await play());
      await sleep(1500);
      const t0 = Date.now();
      const playing = await poll(async () => (await state()).some((a) => !a.paused && a.t > 0), { timeout: 12000, every: 200 });
      const s1 = await state();
      await verdict("5.play", !!playing, `${playing ? `audio playing, currentTime ${s1.find((a) => !a.paused)?.t.toFixed(2)} s after ${1500 + Date.now() - t0} ms` : `not playing: ${JSON.stringify(s1)}`}`);
      await tap(await play());
      const paused = await poll(async () => (await state()).every((a) => a.paused), { timeout: 5000, every: 150 });
      await verdict("5.pause", !!paused, paused ? "second tap paused it" : "still playing after the second tap");
    }

    // Back closes ONLY the sheet
    await back();
    const closed = await sheetGone("species");
    const afterBack = await where();
    const listStill = (await countTiles("button.species-tile")) > 0 && (await currentView()) === "wildlife";
    await verdict("5.back", !!closed && afterBack === "/kestrel/wildlife" && listStill, `sheet ${closed ? "closed" : "STILL OPEN"}, ${afterBack}, list ${listStill ? "still there" : "GONE"}`);
    if (!closed) { await page.keyboard.press("Escape"); await sheetGone("species", 3000); }

    // Escape
    await openSheet();
    await sleep(600);
    await page.keyboard.press("Escape");
    const escClosed = await sheetGone("species");
    const escUrl = await where();
    await verdict("5.escape", !!escClosed && escUrl === "/kestrel/wildlife", `sheet ${escClosed ? "closed" : "STILL OPEN"}, ${escUrl}`);
    if (!escClosed) { await back(); await sheetGone("species", 3000); }

    // Scrim
    const reopened = await openSheet();
    await sleep(900);
    if (!reopened) skip("5.scrim", "the sheet did not reopen");
    else {
      const geo = await ev(() => {
        const s = window.__deep(window.__panel(), "kestrel-lu-sheet[layer=species]")[0];
        const d = s.shadowRoot.querySelector(".panel") ?? window.__deep(s.shadowRoot, "dialog").find((x) => x.open); // the native dialog covers the whole screen: the PANEL is the sheet
        const r = d.getBoundingClientRect();
        return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: innerWidth, h: innerHeight };
      });
      let scrim = null;
      if (geo.t >= 30) scrim = { x: geo.w / 2, y: Math.max(8, geo.t / 2) };
      else if (geo.l >= 30) scrim = { x: geo.l / 2, y: geo.h / 2 };
      else if (geo.w - geo.r >= 30) scrim = { x: geo.r + (geo.w - geo.r) / 2, y: geo.h / 2 };
      if (!scrim) skip("5.scrim", `the sheet covers the whole screen (${Math.round(geo.l)},${Math.round(geo.t)} to ${Math.round(geo.r)},${Math.round(geo.b)}), no scrim to press`);
      else {
        const inside = { x: (geo.l + geo.r) / 2, y: geo.t + (geo.b - geo.t) * 0.6 };
        await drag(inside, scrim);
        await sleep(900);
        const stayed = (await sheetState("species")).open;
        let closedByScrim = false;
        if (stayed) {
          await tapAt(scrim.x, scrim.y);
          closedByScrim = !!(await sheetGone("species", 5000));
        }
        await verdict("5.scrim", stayed && closedByScrim, `press that began inside the sheet and ended on the scrim (${Math.round(scrim.x)},${Math.round(scrim.y)}): sheet ${stayed ? "stayed open" : "CLOSED"}; press on the scrim: ${stayed ? (closedByScrim ? "closed" : "did NOT close") : "not tried"}`);
      }
      if ((await sheetState("species")).open) { await page.keyboard.press("Escape"); await sheetGone("species", 3000); }
    }
    await sleep(500);

    // The species sheet in depth: focus, Tab trap, focus back, scroll lock, safe areas, geometry, swipe, theme
    await proveSheet({ prefix: "5", layer: "species", extras: [], opener: () => speciesTile(heardLabel) });
    await sleep(400);

    // 8. each tab remembers its scroll (sheet closed, Wildlife showing)
    const wMax = await ev(() => window.__max());
    if (wMax < 410) { skip("8.wild", `Wildlife scrolls only ${Math.round(wMax)} px at this size`); skip("8.live", "needs the Wildlife scroll first"); }
    else {
      await ev(() => window.__scroller().scrollTo(400));
      await sleep(500);
      const w1 = await ev(() => window.__scroller().top);
      await gotoTab("live");
      await sleep(800);
      const lMax = await ev(() => window.__max());
      if (lMax < 210) {
        skip("8.live", `Live scrolls only ${Math.round(lMax)} px at this size`);
        await gotoTab("wildlife");
        await sleep(800);
        const w2 = await ev(() => window.__scroller().top);
        await verdict("8.wild", Math.abs(w2 - w1) <= 3, `Wildlife ${Math.round(w1)} -> ${Math.round(w2)}`);
      } else {
        await ev(() => window.__scroller().scrollTo(200));
        await sleep(500);
        const l1 = await ev(() => window.__scroller().top);
        await gotoTab("wildlife");
        await sleep(900);
        const w2 = await ev(() => window.__scroller().top);
        await gotoTab("live");
        await sleep(900);
        const l2 = await ev(() => window.__scroller().top);
        await verdict("8.wild", Math.abs(w2 - w1) <= 3, `Wildlife ${Math.round(w1)} -> (Live) -> ${Math.round(w2)}`);
        await verdict("8.live", Math.abs(l2 - l1) <= 3, `Live ${Math.round(l1)} -> (Wildlife) -> ${Math.round(l2)}`);
      }
    }

    // 11 (part): the AI check-up tab
    await gotoTab("insights");
    await poll(() => ev(() => window.__deep(window.__panel(), ".health-tile").length), { timeout: 20000, every: 250 });
    await sleep(1200);
    await shot("insights");
  }, ["4.tiles", "4.filter", "4.cycle", "4.badges", "5.open", "5.sections", "5.play", "5.pause", "5.back", "5.escape", "5.scrim", ...SHEET_IDS["5"], "9.theme", "8.wild", "8.live"]);

  // ---------------- C: keyboard ----------------
  await group("keys", async () => {
    // This Chromium reports no pointing device at all ((pointer: fine) is false even on a desktop size and cannot be emulated), so
    // "fine pointer sizes" is the two non-touch sizes. The key handler itself does not look at the pointer; only the help button does.
    const fine = await ev(() => matchMedia("(pointer: fine)").matches);
    if (c.size.touch) { const why = `touch size ${c.size.w}x${c.size.h}: the shortcuts are for a keyboard`; skip("10.keys", why); for (const id of SHEET_IDS["12"]) skip(id, `${why}; the help sheet's button is shown only for a mouse and keyboard`); return; }
    // The digit shortcuts listen only when matchMedia says "hover: hover and pointer: fine". Tell THIS page so (a fresh load, before
    // the first key press, because the nav keeps the first answer); nothing else in the matrix runs with this shim.
    await open("/kestrel/live", c, () => window.__deep(window.__panel(), "article.camera-tile").length > 0);
    await ev(() => {
      const original = window.matchMedia.bind(window);
      window.matchMedia = (query) => {
        const list = original(query);
        if (!/pointer:\s*fine|hover:\s*hover/.test(query)) return list;
        return new Proxy(list, { get: (target, key) => (key === "matches" ? true : typeof target[key] === "function" ? target[key].bind(target) : target[key]) });
      };
    });
    await page.keyboard.press("2");
    const toWild = await poll(async () => (await currentView()) === "wildlife" && (await where()).startsWith("/kestrel/wildlife"), { timeout: 4000 });
    await page.keyboard.press("1");
    const toLive = await poll(async () => (await currentView()) === "live" && (await where()).startsWith("/kestrel/live"), { timeout: 4000 });
    await sleep(600);
    // Kestrel's shortcut sheet opens from the keyboard button in the bar (there is no '?' handler any more; Home Assistant owns '?').
    // That button is shown by CSS only for "hover: hover and pointer: fine", which this Chromium never matches: show it for this page.
    await ev(() => { const sheet = new CSSStyleSheet(); sheet.replaceSync(".shortcuts { display: inline-flex !important; }"); const root = window.__panel(); root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet]; });
    await sleep(300);
    const button = await handle(() => window.__deep(window.__shell().shadowRoot, "kestrel-lu-button.shortcuts").concat(window.__deep(window.__panel(), "kestrel-lu-button.shortcuts")).find((b) => window.__shown(b)) ?? null);
    let help = null, rows = [], helpGone = false;
    if (button) {
      await tap(button);
      help = await sheetUp("help", 8000);
      rows = help ? await ev(() => window.__deep(window.__deep(window.__panel(), "kestrel-lu-sheet[layer=help]")[0], "kbd").map((k) => k.textContent.trim())) : [];
      await sleep(600);
      await page.keyboard.press("Escape");
      helpGone = !!(await sheetGone("help", 4000));
    }
    const rowsOk = rows.includes("1") && rows.includes("2") && rows.includes("Esc") && !rows.includes("?");
    await verdict("10.keys", !!toWild && !!toLive && !!button && !!help && rowsOk && helpGone, `this browser reports (pointer: fine)=${fine}, so the page was told it has one (matchMedia shim, button shown) for this check; '2' -> ${toWild ? "Wildlife" : "no"}; '1' -> ${toLive ? "Live" : "no"}; keyboard button ${button ? "found" : "NOT found"}; sheet ${help ? "opened" : "did NOT open"} with keys [${rows.join(" ")}]${rowsOk ? "" : " (want 1, 2, Esc and no ?)"}; Escape -> ${helpGone ? "closed" : "still open"}`);
    if (button && !helpGone) { await back(); }
    if (!button) for (const id of SHEET_IDS["12"]) skip(id, "the keyboard button was not found");
    else {
      // The help sheet in depth (opened by the keyboard button, as above): Back, Esc, scrim, focus, Tab trap, focus back on the button, scroll lock,
      // safe areas, geometry, theme. (The swipe is a finger gesture: skipped on these mouse sizes.)
      const shortcutButton = () => handle(() => window.__deep(window.__shell().shadowRoot, "kestrel-lu-button.shortcuts").concat(window.__deep(window.__panel(), "kestrel-lu-button.shortcuts")).find((b) => window.__shown(b)) ?? null);
      await proveSheet({ prefix: "12", layer: "help", extras: ["back", "escape", "scrim"], opener: shortcutButton });
    }
  }, ["10.keys", ...SHEET_IDS["12"]]);

  // ---------------- D: sighting page and Back ----------------
  await group("visit", async () => {
    await open("/kestrel/wildlife", c, () => window.__deep(window.__panel(), "button.species-tile").length > 0);
    await sleep(1200);
    const max = await ev(() => window.__max());
    const want = max >= 150 ? Math.min(Math.floor(max), 300) : 0;
    if (want) { await ev((t) => window.__scroller().scrollTo(t), want); await sleep(600); }
    // a tile with recordings, preferably one already on screen after the scroll (a short screen scrolls to it)
    const tileH = await handle(() => {
      const all = window.__deep(window.__panel(), "button.species-tile").filter((t) => t.getBoundingClientRect().width > 0 && /recording|video/.test(t.getAttribute("aria-label") ?? ""));
      const onScreen = all.filter((t) => { const r = t.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; });
      const pool = onScreen.length ? onScreen : all;
      return pool.find((t) => !/Great Horned/.test(t.getAttribute("aria-label"))) ?? pool[0] ?? null;
    });
    if (!tileH) { for (const id of ["7.visit", "7.picker", "7.backpicker", "7.backsheet", "7.backlist"]) skip(id, "no species tile with recordings to open"); return; }
    await tileH.scrollIntoViewIfNeeded().catch(() => undefined);
    await sleep(500);
    const before = await ev(() => window.__scroller().top);
    const label = (await tileLabel(tileH)).split(".")[0];
    await tap(tileH);
    await sheetUp("species", 8000);
    await poll(() => ev(() => { const s = window.__deep(window.__panel(), "kestrel-lu-sheet[layer=species]")[0]; return window.__in(s, "kestrel-lu-audio-list", "button.open").length + window.__in(s, "kestrel-lu-media-rail", ".item").length; }), { timeout: 25000, every: 250 });
    await sleep(600);
    const sheetUrl = await where();
    const rowH = await handle(() => { const s = window.__deep(window.__panel(), "kestrel-lu-sheet[layer=species]")[0]; return window.__in(s, "kestrel-lu-audio-list", "button.open")[0] ?? window.__in(s, "kestrel-lu-media-rail", ".item")[0] ?? null; });
    if (!rowH) { for (const id of ["7.visit", "7.picker", "7.backpicker", "7.backsheet", "7.backlist"]) skip(id, `${label} has no recording row or clip to open`); return; }
    await tap(rowH);
    const onVisit = await poll(async () => (await where()).startsWith("/kestrel/visit") && (await currentView()) === "visit", { timeout: 10000 });
    await poll(() => ev(() => window.__deep(window.__panel(), 'kestrel-lu-button[label="Wrong?"]').some((b) => window.__shown(b))), { timeout: 25000, every: 250 });
    await sleep(1000);
    const page1 = await ev(() => {
      const sh = window.__shell();
      const back = window.__deep(sh.shadowRoot, "button.back").find((b) => window.__shown(b));
      const tabs = window.__nav().filter((a) => window.__shown(a)).length;
      const right = window.__deep(window.__panel(), "kestrel-lu-button").find((b) => /That.s right|Confirmed/.test(b.getAttribute("label") ?? "") && window.__shown(b));
      const r = right?.getBoundingClientRect();
      return { back: !!back, tabs, right: !!right, inView: !!r && r.top >= 0 && r.bottom <= innerHeight, bottom: r ? Math.round(r.bottom) : null, h: innerHeight, heading: sh.getAttribute("heading") };
    });
    const visitOk = !!onVisit && page1.back && page1.tabs === 0 && page1.right && (cell.size.w > 500 || page1.inView);
    await verdict("7.visit", visitOk, `${label}: ${await where()}; back arrow ${page1.back}, tabs shown ${page1.tabs}, "That's right" ${page1.right ? `bottom ${page1.bottom}/${page1.h}` : "missing"}${cell.size.w > 500 ? " (in-view only required on the phone)" : ` in view ${page1.inView}`}`);
    await shot("visit");
    const visitUrl = await where();
    const wrong = () => handle(() => window.__deep(window.__panel(), 'kestrel-lu-button[label="Wrong?"]').find((b) => window.__shown(b)) ?? null);
    if (!(await wrong())) { skip("7.picker", "no 'Wrong?' button on this page"); for (const id of SHEET_IDS["7"]) skip(id, "no 'Wrong?' button on this page"); }
    else {
      await tap(await wrong());
      const picker = await sheetUp("wrong-picker", 6000);
      await verdict("7.picker", !!picker, `picker lu-sheet open=${picker?.open}, HA dialog shown=${picker?.dialog}`);
      await sleep(900);
      await shot("picker");
      await back();
      const pickerGone = await sheetGone("wrong-picker");
      const nowUrl = await where();
      await verdict("7.backpicker", !!pickerGone && nowUrl === visitUrl && (await currentView()) === "visit", `picker ${pickerGone ? "closed" : "STILL OPEN"}, ${nowUrl}`);
      if (await sheetUp("wrong-picker", 300)) { await page.keyboard.press("Escape"); await sheetGone("wrong-picker", 3000); }
      // The picker in depth (the visit page is showing, the picker closed): Esc, scrim, focus (the search box on a mouse, the sheet on touch), Tab trap,
      // focus back on "Wrong?", scroll lock, safe areas, geometry, swipe, theme.
      await proveSheet({ prefix: "7", layer: "wrong-picker", extras: ["escape", "scrim"], opener: wrong });
    }
    if (await sheetUp("wrong-picker", 300)) { await page.keyboard.press("Escape"); await sheetGone("wrong-picker", 3000); }
    await back();
    const sheetBack = await sheetUp("species", 6000);
    const sUrl = await where();
    await verdict("7.backsheet", !!sheetBack && sUrl === sheetUrl, `species sheet ${sheetBack ? "open" : "NOT open"}, ${sUrl}`);
    await back();
    const shut = await sheetGone("species", 6000);
    await sleep(1200);
    const after = await ev(() => window.__scroller().top);
    const finalUrl = await where();
    if (want === 0) {
      await verdict("7.backlist", !!shut && finalUrl === "/kestrel/wildlife", `sheet ${shut ? "closed" : "STILL OPEN"}, ${finalUrl}; scroll check skipped: the list scrolls only ${Math.round(max)} px at this size`);
    } else {
      await verdict("7.backlist", !!shut && finalUrl === "/kestrel/wildlife" && Math.abs(after - before) <= 3, `sheet ${shut ? "closed" : "STILL OPEN"}, ${finalUrl}, scroll ${Math.round(before)} -> ${Math.round(after)}`);
    }
  }, ["7.visit", "7.picker", "7.backpicker", "7.backsheet", "7.backlist", ...SHEET_IDS["7"]]);

  // ---------------- E: heard visit with a cleaned preview ----------------
  await group("preview", async () => {
    if (!heardCandidate) { await open("/kestrel/live", c); heardCandidate = await findHeard(); }
    if (!heardCandidate || heardCandidate.error || heardCandidate.none) {
      const why = heardCandidate?.error ? `kestrel/visits failed: ${heardCandidate.error}` : `none of the ${heardCandidate?.count ?? "?"} latest heard visits has audioOriginal with audioInfo.state ready`;
      for (const id of ["6.player", "6.switch", "6.cleaned"]) skip(id, why);
      return;
    }
    await open(`/kestrel/visit?v=${encodeURIComponent(heardCandidate.id)}`, c, () => window.__deep(window.__panel(), "kestrel-lu-audio-player").length > 0);
    await sleep(1200);
    const info = () => ev(() => {
      const p = window.__deep(window.__panel(), "kestrel-lu-audio-player")[0];
      if (!p) return null;
      const audio = p.shadowRoot.querySelector("audio");
      const toggle = [...p.shadowRoot.querySelectorAll("button.toggle")].find((b) => /Original/.test(b.textContent));
      const mark = p.shadowRoot.querySelector(".mark")?.textContent.trim() ?? null;
      return { src: audio?.currentSrc || audio?.getAttribute("src") || "", toggle: !!toggle, pressed: toggle?.getAttribute("aria-pressed") ?? null, mark };
    });
    const i0 = await info();
    await verdict("6.player", !!i0 && i0.toggle && i0.src !== "", `${heardCandidate.species}: recording player ${i0 ? "there" : "MISSING"}, Original toggle ${i0?.toggle ? "there" : "MISSING"}`);
    const path = (u) => { try { return new URL(u, location.href).pathname; } catch { return u; } };
    const origPath = new URL(heardCandidate.original, BASE).pathname;
    const togglePress = () => handle(() => { const p = window.__deep(window.__panel(), "kestrel-lu-audio-player")[0]; return [...p.shadowRoot.querySelectorAll("button.toggle")].find((b) => /Original/.test(b.textContent)) ?? null; });
    if (!i0?.toggle) skip("6.switch", "no Original toggle");
    else {
      const hit = await ev(() => { const p = window.__deep(window.__panel(), "kestrel-lu-audio-player")[0]; const b = [...p.shadowRoot.querySelectorAll("button.toggle")].find((x) => /Original/.test(x.textContent)); b.scrollIntoView({ block: "center" }); const r = b.getBoundingClientRect(); const x = r.x + r.width / 2, y = r.y + r.height / 2; let el = document.elementFromPoint(x, y); while (el?.shadowRoot) { const inner = el.shadowRoot.elementFromPoint(x, y); if (!inner || inner === el) break; el = inner; } return `${el?.localName}${el?.className ? "." + el.className : ""} at (${Math.round(x)},${Math.round(y)}) of ${innerWidth}x${innerHeight}; toggle is ${el === b ? "the element hit" : "NOT the element hit"}`; });
      await tap(await togglePress());
      const switched = async () => { const x = await info(); return x && x.pressed === "true" && new URL(x.src, BASE).pathname !== new URL(i0.src, BASE).pathname ? x : null; };
      let on = await poll(switched, { timeout: 4000 });
      if (!on) { console.log(`INFO  [${cell.key}] the Original tap did not switch within 4 s (${hit}); tapping once more`); await tap(await togglePress()); on = await poll(switched, { timeout: 10000 }); }
      const lastOn = on ?? (await info());
      await tap(await togglePress());
      const off = await poll(async () => { const x = await info(); return x && x.pressed === "false" && new URL(x.src, BASE).pathname === new URL(i0.src, BASE).pathname ? x : null; }, { timeout: 10000 });
      const onPath = on ? new URL(on.src, BASE).pathname : null;
      await verdict("6.switch", !!on && !!off && onPath === origPath, `Original: ${on ? "" : `no switch [tap ${hit}] (pressed=${lastOn?.pressed}, src ...${(lastOn?.src ?? "").slice(-30)}); `}src ...${(onPath ?? "none").slice(-34)} (want ...${origPath.slice(-34)}); again: ${off ? "back to the preview" : "did NOT switch back"}`);
    }
    if (!heardCandidate.cleaned) skip("6.cleaned", `none of the heard visits with an Original has audioInfo.cleaned today (mark shown: "${i0?.mark ?? "none"}")`);
    else await verdict("6.cleaned", i0?.mark === "Cleaned", `mark "${i0?.mark}"`);
  }, ["6.player", "6.switch", "6.cleaned"]);

  // ---------------- cell wrap-up ----------------
  if (ONLY) { await clearEmulation(); return; }
  const missing = ["live", "wildlife", "species", "visit", "picker", "insights"].filter((s) => !c.shots.has(s));
  const files = ["live", "wildlife", "species", "visit", "picker", "insights"].filter((s) => existsSync(`${OUT}/${c.theme.name === "Neumorphism" ? "flat-light" : "glass-dark"}-${c.size.w}x${c.size.h}-${s}.png`));
  await verdict("11.shots", missing.length === 0 && files.length === 6, missing.length ? `missing: ${missing.join(", ")}` : `6 PNGs in ${OUT}`);
  await verdict("1.errors", errors.length === 0, errors.length ? `${errors.length}: ${[...new Set(errors)].slice(0, 2).join(" | ")}` : `none${ignored ? ` (${ignored} from Scrypted's own camera card ignored)` : ""}`);
  await clearEmulation();
}

// ---- run ---------------------------------------------------------------------------------------------------------------------------
const loadBefore = load();
let loaded = [];
let exitCode = 0;
try {
  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  await ensureLogin();
  const cells = [];
  for (const t of wantThemes) for (const s of wantSizes) cells.push({ key: `${THEMES[t].code}:${s} ${SIZES[s].w}x${SIZES[s].h}`, size: SIZES[s], theme: THEMES[t], themeKey: t, sizeKey: s, shots: new Set() });
  for (const c of cells) {
    if (page.isClosed()) { console.log(`ABORT  the shared browser's page is gone; cell ${c.key} and the ones after it were not run`); break; }
    try { await runCell(c); } catch (error) {
      cell = c;
      mark("1.errors", "FAIL", `cell aborted: ${String(error?.message ?? error).split("\n")[0].slice(0, 160)}`);
      fails.push({ cell: c.key, id: "cell", detail: String(error?.stack ?? error).split("\n").slice(0, 2).join(" / ") });
    } finally { await clearEmulation(); }
    if (page.isClosed()) { console.log(`ABORT  the shared browser's page went away during ${c.key}; the remaining cells were not run`); break; }
    if (!loaded.length) loaded = await page.evaluate(() => performance.getEntriesByType("resource").map((r) => r.name).filter((n) => n.includes("kestrel-static")).map((n) => n.replace(location.origin, ""))).catch(() => []);
  }

  // ---- table ----
  const codes = cells.map((c) => `${c.theme.code}-${c.sizeKey.slice(0, 5)}`);
  const sym = { PASS: "PASS", FAIL: "FAIL", SKIP: "skip" };
  const rows = CHECKS.map(([id, label]) => [id, ...cells.map((c) => { const r = results.find((x) => x.cell === c.key && x.id === id); return r ? sym[r.status] : "-"; })]);
  console.log(`\n${"check".padEnd(13)}${codes.map((x) => x.padEnd(11)).join("")}`);
  for (const row of rows) console.log(`${row[0].padEnd(13)}${row.slice(1).map((x) => x.padEnd(11)).join("")}`);
  const total = { PASS: 0, FAIL: 0, SKIP: 0 };
  for (const r of results) total[r.status] += 1;
  console.log(`\n${total.PASS} PASS, ${total.FAIL} FAIL, ${total.SKIP} SKIP`);
  if (fails.length) {
    console.log("\nFAILURES");
    for (const f of fails) console.log(`- [${f.cell}] ${f.id}: ${f.detail}`);
  }
  // Which bundle did the page get? The bytes served by interception, and the hash of what the page itself received for the request.
  const receivedHash = await page.evaluate(async (url) => {
    try { const body = await (await fetch(url, { cache: "no-store" })).arrayBuffer(); return [...new Uint8Array(await crypto.subtle.digest("SHA-256", body))].map((b) => b.toString(16).padStart(2, "0")).join(""); } catch { return null; }
  }, loaded[0] ?? "").catch(() => null);
  console.log(`\nbundle: ${BUNDLE}${localFile ? ` -> served ${localFile} into ${routed} request(s)` : " (no interception: the bundle Home Assistant serves)"}; the page requested: ${loaded.join(", ") || "(unknown)"}`);
  console.log(`bundle the page received: sha256:${receivedHash ? receivedHash.slice(0, 12) : "(could not be fetched)"}${servedHash ? (receivedHash === servedHash ? " = the served file" : " != the served file (the interception did not reach this request)") : ""}`);
  console.log(`load before: ${loadBefore}; after: ${load()}  (timings are PROVISIONAL when the first number is >= 8)`);
  console.log(`screenshots: ${OUT}/<theme>-<WxH>-<step>.png (live, wildlife, species, visit, picker, insights)`);
  writeFileSync(`${OUT}/results.json`, JSON.stringify({ bundle: BUNDLE, localFile, loaded, loadBefore, loadAfter: load(), results }, null, 1));
  exitCode = fails.length ? 1 : 0;
} finally {
  // Put the shared browser back as it was: this run's own tab is closed, and the storage is logged out again if it was logged out when the run began.
  page.off("console", onConsole);
  page.off("pageerror", onPageError);
  await clearEmulation();
  if (BUNDLE !== "installed") await page.unroute(ROUTE).catch(() => undefined);
  try {
    if (loggedOutAtStart) {
      await page.goto(`${BASE}/auth/authorize`, { waitUntil: "domcontentloaded" });
      await page.evaluate((entries) => { localStorage.clear(); for (const [k, v] of entries) localStorage.setItem(k, v); }, storageAtStart);
    }
    console.log(`restored: this run's tab closed${loggedOutAtStart ? ", the browser is logged out again (localStorage as it was)" : ", the browser's login untouched"}; other tabs were not touched`);
  } catch (error) { console.log(`restore failed: ${String(error?.message ?? error).split("\n")[0]}`); }
  await page.close().catch(() => undefined);
  await browser.close().catch(() => undefined); // only disconnects; the shared browser keeps running
}
process.exit(exitCode);
