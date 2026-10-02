#!/usr/bin/env node
// The user-visible requirements, proven on the REAL Home Assistant in the SHARED browser (the one the user watches).
//   taskset -c 0-4,8-12 nice -n 15 node dev/smoke/real-matrix.mjs [--bundle local|installed] [--sizes phone,smart,tablet,desktop,wide]
//                                                                   [--themes flat-light,glass-dark] [--out /tmp/kestrel-matrix]
// 10 cells = 5 sizes x 2 themes. Each cell prints one PASS / FAIL / SKIP line per check; the end prints one table and writes
// $OUT/results.json. Exits non-zero when a check failed. Timing numbers are PROVISIONAL on a busy host (the load is printed before/after).
//
//   --bundle local      (default) the newest file in custom_components/kestrel/frontend is served into the real page by request
//                       interception, so a build can be proven before it is released.
//   --bundle installed  no interception: the bundle Home Assistant serves (the post-release run).
//
// It attaches to the already-running shared Chromium (CDP, default http://127.0.0.1:43977), reuses its page, and puts everything back
// at the end: emulation (size, touch), the request route, the theme (Neumorphism, light) and the address. It NEVER writes real data: no
// correction, confirm, mute or setting is ever pressed ("That's right" and the picker's species rows are never tapped).
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
const BUNDLE = String(flag("bundle", "local"));
const ONLY = flag("only", null); // --only keys|live|wildlife|visit|preview : run one group of checks (a quick re-proof), no table for the rest
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
const wantSizes = String(flag("sizes", Object.keys(SIZES).join(","))).split(",").filter(Boolean);
const wantThemes = String(flag("themes", Object.keys(THEMES).join(","))).split(",").filter(Boolean);
for (const s of wantSizes) if (!SIZES[s]) { console.error(`unknown size ${s}; use ${Object.keys(SIZES).join(", ")}`); process.exit(2); }
for (const t of wantThemes) if (!THEMES[t]) { console.error(`unknown theme ${t}; use ${Object.keys(THEMES).join(", ")}`); process.exit(2); }
if (!["local", "installed"].includes(BUNDLE)) { console.error("--bundle local|installed"); process.exit(2); }

// The checks, in table order: id -> label.
const CHECKS = [
  ["1.pinned", "app bar pinned on scroll"], ["1.nav", "destinations in the fitting layout"], ["1.overflow", "no horizontal overflow"],
  ["1.tiles", "camera tiles + grid columns"], ["1.errors", "no console errors (whole cell)"],
  ["2.menu", "HA menu button iff drawer"], ["2.open", "menu tap opens HA drawer"], ["2.toggle", "second tap closes drawer"], ["2.escape", "Escape closes drawer"],
  ["3.focus", "tile -> focused camera (ms)"], ["3.picture", "picture/video frame (ms, PROVISIONAL)"], ["3.back", "'All cameras' returns to grid"], ["3.snapshot", "snapshot-only camera shows picture"],
  ["4.tiles", "wildlife tiles shown"], ["4.filter", "filter All/On camera/Heard + counts"], ["4.cycle", "Heard/On camera/All change tiles"], ["4.badges", "evidence badges video/waveform"],
  ["5.open", "species sheet opens, ?s="], ["5.sections", "On camera + Heard sections"], ["5.play", "recording plays"], ["5.pause", "second tap pauses"],
  ["5.back", "Back closes ONLY the sheet"], ["5.escape", "Escape closes the sheet"], ["5.scrim", "scrim: only a press that began there"],
  ["6.player", "heard visit: player + Original toggle"], ["6.switch", "Original switches source and back"], ["6.cleaned", "'Cleaned' mark"],
  ["7.visit", "recording row -> visit page"], ["7.picker", "'Wrong?' opens picker"], ["7.backpicker", "Back closes ONLY the picker"], ["7.backsheet", "Back -> species sheet"], ["7.backlist", "Back -> list, same scroll"],
  ["8.wild", "Wildlife keeps its scroll"], ["8.live", "Live keeps its scroll"],
  ["9.theme", "theme switch live (sheet open)"], ["10.keys", "keys 2, 1, shortcut button, Esc (non-touch)"], ["11.shots", "6 screenshots written"],
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
const page = context.pages().find((p) => p.url().startsWith(BASE)) ?? context.pages()[0];
const cdp = await context.newCDPSession(page);
const originalUrl = page.url().startsWith(BASE) ? page.url() : `${BASE}/`;
const errors = [];
// Scrypted's own camera card (a third-party component) logs its own failures: RpcPeer, engine.io, node:events. They are counted, not blamed on Kestrel.
const thirdParty = (text) => /RpcPeer|@scrypted|engine\.io|node:events|scrypted/i.test(text);
let ignored = 0;
const record = (text) => { if (thirdParty(text)) ignored += 1; else errors.push(text.slice(0, 220)); };
const onConsole = (m) => { if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) record(m.text()); };
const onPageError = (e) => { if (String(e.message) !== "closed") record(`pageerror: ${String(e.message ?? e)}${e.stack ? ` ${e.stack}` : ""}`); };

let localFile = null;
let routed = 0;
const ROUTE = "**/kestrel-static/kestrel.*.js*";
if (BUNDLE === "local") {
  const dir = join(root, "custom_components/kestrel/frontend");
  localFile = readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => join(dir, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  const body = readFileSync(localFile);
  localFile = `${localFile.split("/").pop()} sha256:${createHash("sha256").update(body).digest("hex").slice(0, 12)}`;
  await page.route(ROUTE, (route) => { routed += 1; return route.fulfill({ status: 200, contentType: "application/javascript", body }); });
}

async function ensureLogin() {
  const has = await page.evaluate(() => !!localStorage.getItem("hassTokens")).catch(() => false);
  if (has) return;
  const token = readFileSync(TOKEN_FILE, "utf8").trim();
  await page.goto(`${BASE}/auth/authorize`, { waitUntil: "domcontentloaded" }).catch(() => undefined);
  await page.evaluate(([t, base]) => localStorage.setItem("hassTokens", JSON.stringify({ access_token: t, token_type: "Bearer", expires_in: 1800, hassUrl: base, clientId: `${base}/`, expires: Date.now() + 365 * 864e5, refresh_token: "" })), [token, BASE]);
}

async function emulate(c) {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: c.size.w, height: c.size.h, deviceScaleFactor: 1, mobile: c.size.mobile });
  if (c.size.touch) await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
}
async function clearEmulation() {
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
const gotoTab = async (id) => { await tap(await tabHandle(id)); await sleep(600); };
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

async function applyTheme(theme) {
  await ev(([name, dark]) => document.querySelector("home-assistant").dispatchEvent(new CustomEvent("settheme", { detail: { theme: name, dark }, bubbles: true, composed: true })), [theme.name, theme.dark]);
  await sleep(1200);
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
  await applyTheme(c.theme);
  await poll(() => ev(() => !!window.__shell()), { timeout: 40000, every: 200 });
  if (ready) await poll(() => ev(ready), { timeout: 40000, every: 200 });
  await sleep(800);
}
const countTiles = (sel) => ev((want) => window.__deep(window.__panel(), want).length, sel);

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
    heardCandidate = await ev(async () => {
      try {
        const r = await document.querySelector("home-assistant").hass.callWS({ type: "kestrel/visits", kind: "heard", limit: 30 });
        const ready = (r.items ?? r).filter((v) => v.audioOriginal && v.audioInfo?.state === "ready");
        const item = ready.find((v) => v.audioInfo?.cleaned) ?? ready[0];
        return item ? { id: item.id, original: item.audioOriginal, cleaned: !!item.audioInfo?.cleaned, species: item.species } : { none: true, count: (r.items ?? r).length };
      } catch (error) { return { error: String(error?.message ?? error).slice(0, 120) }; }
    });

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
    await gotoTab("wildlife");
    await poll(() => countTiles("button.species-tile"), { timeout: 60000, every: 250 });
    await sleep(1200);
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
    if (!heardLabel) { for (const id of ["5.open", "5.sections", "5.play", "5.pause", "5.back", "5.escape", "5.scrim", "9.theme"]) skip(id, "no species tile to open"); return; }
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
    await applyTheme(other);
    await sleep(600);
    const p1 = await paint();
    await applyTheme(c.theme);
    await sleep(600);
    const p2 = await paint();
    await verdict("9.theme", p0.nonce === p1.nonce && p1.open && p1.bar !== p0.bar && p1.text !== p0.text && p2.bar === p0.bar && p2.text === p0.text, `no reload (nonce kept), bar ${p0.bar.slice(0, 60)} -> ${p1.bar.slice(0, 60)}, sheet text ${p0.text} -> ${p1.text}, back to ${p2.bar === p0.bar && p2.text === p0.text ? "the same colours" : "DIFFERENT colours"}`);

    // play / pause
    const ready = await rowsReady();
    if (!ready) { skip("5.play", "the Heard section has no playable row"); skip("5.pause", "the Heard section has no playable row"); }
    else {
      const play = () => handle(() => { const s = window.__deep(window.__panel(), "kestrel-lu-sheet[layer=species]")[0]; return window.__in(s, "kestrel-lu-audio-list", "button.play:not([disabled])")[0] ?? null; });
      const state = () => ev(() => window.__deep(document, "audio").map((a) => ({ paused: a.paused, t: a.currentTime, src: a.currentSrc.split("?")[0].slice(-40) })));
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
        const d = window.__deep(s.shadowRoot, "dialog").find((x) => x.open);
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
  }, ["4.tiles", "4.filter", "4.cycle", "4.badges", "5.open", "5.sections", "5.play", "5.pause", "5.back", "5.escape", "5.scrim", "9.theme", "8.wild", "8.live"]);

  // ---------------- C: keyboard ----------------
  await group("keys", async () => {
    // This Chromium reports no pointing device at all ((pointer: fine) is false even on a desktop size and cannot be emulated), so
    // "fine pointer sizes" is the two non-touch sizes. The key handler itself does not look at the pointer; only the help button does.
    const fine = await ev(() => matchMedia("(pointer: fine)").matches);
    if (c.size.touch) { skip("10.keys", `touch size ${c.size.w}x${c.size.h}: the shortcuts are for a keyboard`); return; }
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
  }, ["10.keys"]);

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
    if (!(await wrong())) { skip("7.picker", "no 'Wrong?' button on this page"); }
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
  }, ["7.visit", "7.picker", "7.backpicker", "7.backsheet", "7.backlist"]);

  // ---------------- E: heard visit with a cleaned preview ----------------
  await group("preview", async () => {
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
      await tap(await togglePress());
      const on = await poll(async () => { const x = await info(); return x && x.pressed === "true" && new URL(x.src, BASE).pathname !== new URL(i0.src, BASE).pathname ? x : null; }, { timeout: 10000 });
      const lastOn = on ?? (await info());
      await tap(await togglePress());
      const off = await poll(async () => { const x = await info(); return x && x.pressed === "false" && new URL(x.src, BASE).pathname === new URL(i0.src, BASE).pathname ? x : null; }, { timeout: 10000 });
      const onPath = on ? new URL(on.src, BASE).pathname : null;
      await verdict("6.switch", !!on && !!off && onPath === origPath, `Original: ${on ? "" : `no switch (pressed=${lastOn?.pressed}, src ...${(lastOn?.src ?? "").slice(-30)}); `}src ...${(onPath ?? "none").slice(-34)} (want ...${origPath.slice(-34)}); again: ${off ? "back to the preview" : "did NOT switch back"}`);
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
  console.log(`\n${"check".padEnd(11)}${codes.map((x) => x.padEnd(11)).join("")}`);
  for (const row of rows) console.log(`${row[0].padEnd(11)}${row.slice(1).map((x) => x.padEnd(11)).join("")}`);
  const total = { PASS: 0, FAIL: 0, SKIP: 0 };
  for (const r of results) total[r.status] += 1;
  console.log(`\n${total.PASS} PASS, ${total.FAIL} FAIL, ${total.SKIP} SKIP`);
  if (fails.length) {
    console.log("\nFAILURES");
    for (const f of fails) console.log(`- [${f.cell}] ${f.id}: ${f.detail}`);
  }
  console.log(`\nbundle: ${BUNDLE}${localFile ? ` -> served ${localFile} into ${routed} request(s)` : ""}; the page requested: ${loaded.join(", ") || "(unknown)"}`);
  console.log(`load before: ${loadBefore}; after: ${load()}  (timings are PROVISIONAL when the first number is >= 8)`);
  console.log(`screenshots: ${OUT}/<theme>-<WxH>-<step>.png (live, wildlife, species, visit, picker, insights)`);
  writeFileSync(`${OUT}/results.json`, JSON.stringify({ bundle: BUNDLE, localFile, loaded, loadBefore, loadAfter: load(), results }, null, 1));
  exitCode = fails.length ? 1 : 0;
} finally {
  // Put the shared browser back as it was: size, touch, route, theme, address.
  page.off("console", onConsole);
  page.off("pageerror", onPageError);
  await clearEmulation();
  if (BUNDLE === "local") await page.unroute(ROUTE).catch(() => undefined);
  try {
    for (let attempt = 1; ; attempt += 1) { try { await page.goto(originalUrl, { waitUntil: "domcontentloaded" }); break; } catch (error) { if (attempt >= 4) throw error; await sleep(8000); } }
    await poll(() => page.evaluate(() => !!document.querySelector("home-assistant")?.hass?.connection), { timeout: 30000, every: 250 });
    await page.evaluate(() => document.querySelector("home-assistant").dispatchEvent(new CustomEvent("settheme", { detail: { theme: "Neumorphism", dark: false }, bubbles: true, composed: true })));
    await sleep(1200);
    console.log(`restored: theme ${await page.evaluate(() => JSON.stringify(document.querySelector("home-assistant").hass.selectedTheme))}, address ${page.url()}`);
  } catch (error) { console.log(`restore failed: ${String(error?.message ?? error).split("\n")[0]}`); }
  await browser.close().catch(() => undefined); // only disconnects; the shared browser keeps running
}
process.exit(exitCode);
