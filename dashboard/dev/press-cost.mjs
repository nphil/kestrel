#!/usr/bin/env node
/**
 * What pressing a control costs the panel itself, whatever else the machine is doing.
 *
 * Wall-clock press timing (perf-check) swings between 30 and 400 ms on a busy host. A browser trace does not: this
 * presses each control (finger down, then cancel) and adds up the main thread's own CPU time (trace thread-time) for
 * style, layout, paint, layer and commit work in the 160 ms after the pointer went down, once on the control and once
 * on something inert in the same state, and reports the difference. At 1x CPU that difference is the panel's cost; on
 * a phone four times slower it is four times as much. The press budget is 50 ms including a frame of scheduling, so a
 * control passes while it stays under 8 ms here.
 *
 *   nice -n 15 node dev/press-cost.mjs [--size 390x844] [--rounds 5] [--local]
 *
 * Runs on the real panel through the relay. It uses the bundle Home Assistant serves (the installed one) unless --local
 * serves the newest bundle in custom_components/kestrel/frontend. The controls are the toolkit's: app-shell nav items
 * (`a.item` inside `kestrel-lu-nav`), tiles and chips of the showing view, the segmented filter and the species sheet's
 * recordings (found through the shell, the view stack and `kestrel-lu-sheet`, as in perf-check). --base and --token-file
 * default as in perf-check. Exits non-zero when a control is over budget. Never prints the Home Assistant token.
 */
import { chromium } from "playwright-core";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadavg } from "node:os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (name, fallback = undefined) => { const i = argv.indexOf(`--${name}`); return i < 0 ? fallback : (argv[i + 1]?.startsWith("--") || argv[i + 1] === undefined ? true : argv[i + 1]); };
const base = String(flag("base", process.env.KESTREL_BASE ?? "http://127.0.0.1:8124"));
const tokenFile = String(flag("token-file", process.env.KESTREL_TOKEN_FILE ?? "/data/home/tmp/ha-token"));
const [W, H] = String(flag("size", "390x844")).split("x").map(Number);
const ROUNDS = Number(flag("rounds", 5));
const BUDGET_MS = 8;
const WINDOW_US = 160_000;
const FRAME_WORK = ["UpdateLayoutTree", "Layout", "PrePaint", "Paint", "Layerize", "Commit", "UpdateLayer"];
const median = (values) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : NaN; };

function newestBundle() {
  const dir = join(root, "../custom_components/kestrel/frontend");
  return readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => join(dir, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

const loadBefore = loadavg()[0];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader"] });
const touch = W < 800;
const context = await browser.newContext({ viewport: { width: W, height: H }, hasTouch: touch, isMobile: touch, deviceScaleFactor: touch ? 3 : 1 });
const token = readFileSync(tokenFile, "utf8").trim();
await context.addInitScript(([secret, origin]) => {
  try { if (!localStorage.getItem("hassTokens")) localStorage.setItem("hassTokens", JSON.stringify({ access_token: secret, token_type: "Bearer", expires_in: 1800, hassUrl: origin, clientId: `${origin}/`, expires: Date.now() + 365 * 864e5, refresh_token: "" })); } catch { /* a page without storage */ }
}, [token, base]);
if (flag("local")) {
  const body = readFileSync(newestBundle());
  await context.route("**/kestrel-static/kestrel.*.js*", (route) => route.fulfill({ status: 200, contentType: "application/javascript", body }));
}
const page = await context.newPage();
const cdp = await context.newCDPSession(page);

// In-page: find the panel through shadow roots, then the toolkit parts the controls live in.
const HELPERS = `
window.__deep = (r, s, o = []) => { r.querySelectorAll(s).forEach((e) => o.push(e)); r.querySelectorAll('*').forEach((e) => e.shadowRoot && window.__deep(e.shadowRoot, s, o)); return o; };
window.__k = {
  panel: () => window.__deep(document, 'kestrel-panel')[0],
  sr: () => window.__k.panel()?.shadowRoot,
  shell: () => window.__k.sr().querySelector('kestrel-lu-app-shell'),
  stack: () => window.__k.sr()?.querySelector('kestrel-lu-view-stack'),
  view: (id) => { const stack = window.__k.stack(); return stack?.querySelector(':scope > [data-view="' + (id ?? stack.current) + '"]'); },
  nav: () => window.__deep(window.__k.shell().shadowRoot, 'kestrel-lu-nav')[0],
  navItem: (id) => window.__k.nav()?.shadowRoot.querySelector('a.item[href$="/' + id + '"]'),
  sheet: () => window.__k.sr().querySelector('kestrel-species-sheet')?.shadowRoot.querySelector('kestrel-lu-sheet[layer="species"]'),
  sheetClose: (sheet) => sheet?.shadowRoot.querySelector('.close') ?? (sheet && window.__deep(sheet.shadowRoot, '[data-dialog="close"], [aria-label="Close"]')[0]),
  sheetTitle: (sheet) => sheet?.shadowRoot.querySelector('#title') ?? (sheet && window.__deep(sheet.shadowRoot, 'h2, .header-title')[0]) ?? sheet?.firstElementChild,
};`;
await page.goto(`${base}/kestrel/live`, { waitUntil: "domcontentloaded" });
await page.evaluate(HELPERS);
await page.waitForFunction(() => window.__k.view?.("live")?.querySelector("kestrel-lu-chip[interactive]"), null, { timeout: 60000 });
await page.waitForTimeout(3000);

const TRACE = ["devtools.timeline", "disabled-by-default-devtools.timeline", "toplevel"];
const elementOf = (source) => `(() => (${source})(window.__k))()`;

/** Finds the element, brings it into view without a centred scroll, and returns where to touch it. */
async function aim(source) {
  return page.evaluate(`(() => { const el = ${elementOf(source)}; if (!el) return null; const top = el.getBoundingClientRect().top; el.scrollIntoView({ block: "nearest", inline: "nearest" }); const r = el.getBoundingClientRect(); return { x: r.left + Math.min(40, r.width / 2), y: r.top + Math.min(40, r.height / 2), scrolled: Math.abs(r.top - top) > 1 }; })()`);
}

/** Main-thread frame work (ms of thread time) in the 160 ms after the pointer went down on `source`. */
async function pressOnce(source) {
  const first = await aim(source);
  if (!first) return null;
  await page.waitForTimeout(first.scrolled ? 400 : 200);
  const spot = await aim(source);
  await browser.startTracing(page, { categories: TRACE });
  if (touch) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: spot.x, y: spot.y }] });
    await page.waitForTimeout(300);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
  } else {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: spot.x, y: spot.y });
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: spot.x, y: spot.y, button: "left", clickCount: 1 });
    await page.waitForTimeout(300);
    await page.evaluate(() => window.addEventListener("click", (e) => { e.preventDefault(); e.stopImmediatePropagation(); }, { capture: true, once: true }));
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: spot.x, y: spot.y, button: "left", clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 });
  }
  await page.waitForTimeout(100);
  const events = JSON.parse((await browser.stopTracing()).toString()).traceEvents;
  const down = events.find((e) => e.name === "EventDispatch" && e.args?.data?.type === "pointerdown");
  if (!down) return null;
  return events
    .filter((e) => e.ph === "X" && e.pid === down.pid && e.tid === down.tid && e.ts >= down.ts && e.ts <= down.ts + WINDOW_US && FRAME_WORK.includes(e.name))
    .reduce((sum, e) => sum + (e.tdur ?? e.dur ?? 0), 0) / 1000;
}

const results = [];
/** Presses the control and an inert element alternately, `ROUNDS` times each, and reports the difference of medians. */
async function compare(label, find, inert = "(k) => k.shell().shadowRoot.querySelector('h1.title')") {
  const control = [];
  const floor = [];
  for (let round = 0; round < ROUNDS; round++) {
    const f = await pressOnce(inert); if (f !== null) floor.push(f);
    const c = await pressOnce(find);
    if (c === null) { results.push({ label, skipped: true }); console.log(`${label.padEnd(24)} not on screen, skipped`); return; }
    control.push(c);
  }
  const cost = median(control) - median(floor);
  results.push({ label, control: median(control), floor: median(floor), cost, pass: cost <= BUDGET_MS });
  console.log(`${label.padEnd(24)} ${median(control).toFixed(1).padStart(5)} ms vs inert ${median(floor).toFixed(1).padStart(5)} ms -> ${cost >= 0 ? "+" : ""}${cost.toFixed(1)} ms ${cost <= BUDGET_MS ? "ok" : `OVER ${BUDGET_MS} ms`}`);
}

const NAV = (id) => `(k) => k.navItem('${id}')`;
await compare("camera tile", "(k) => k.view('live').querySelector('.camera-focus')");
await compare("sighting chip", "(k) => k.view('live').querySelector('kestrel-lu-chip[interactive]')?.shadowRoot.querySelector('button.chip')");
await compare("nav tab", NAV("wildlife"));

await page.evaluate(() => window.__k.navItem("wildlife").click());
await page.waitForFunction(() => window.__k.stack().current === "wildlife" && window.__k.view("wildlife")?.querySelector("button.species-tile"), null, { timeout: 30000 });
await page.waitForTimeout(2000);
await compare("species tile", "(k) => k.view('wildlife').querySelector('button.species-tile')");
await compare("filter option", "(k) => [...k.view('wildlife').querySelector('kestrel-lu-segmented').shadowRoot.querySelectorAll('[role=radio]')].find((r) => r.getAttribute('aria-checked') !== 'true')");

// The sheet of the species with the most recordings.
const opened = await page.evaluate(() => {
  const tiles = [...window.__k.view("wildlife").querySelectorAll("button.species-tile")];
  const count = (t) => Number(/(\d+) recordings?/.exec(t.getAttribute("aria-label") ?? "")?.[1] ?? 0);
  const best = tiles.sort((a, b) => count(b) - count(a))[0];
  if (!best || !count(best)) return false;
  best.click();
  return true;
});
if (opened) {
  await page.waitForFunction(() => window.__k.sheet()?.querySelector("kestrel-lu-audio-list")?.shadowRoot.querySelector(".play"), null, { timeout: 20000 }).catch(() => undefined);
  await page.waitForTimeout(2500);
  const title = "(k) => k.sheetTitle(k.sheet())";
  await compare("sheet: play button", "(k) => k.sheet().querySelector('kestrel-lu-audio-list').shadowRoot.querySelector('.play:not(:disabled)')", title);
  await compare("sheet: recording row", "(k) => k.sheet().querySelector('kestrel-lu-audio-list').shadowRoot.querySelector('.open')", title);
  await compare("sheet: close button", "(k) => k.sheetClose(k.sheet())", title);
} else console.log("sheet                    no species with recordings, skipped");

const loadAfter = loadavg()[0];
await browser.close();
const over = results.filter((r) => !r.skipped && !r.pass);
console.log(`\nhost load ${loadBefore.toFixed(1)} -> ${loadAfter.toFixed(1)} (CPU time is nearly load-proof; wall-clock timings are judged by perf-check against its load limit)`);
console.log(over.length ? `${over.length} control(s) over the ${BUDGET_MS} ms budget` : "Every pressed control is within the budget.");
process.exit(over.length ? 1 : 0);
