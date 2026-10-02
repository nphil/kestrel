#!/usr/bin/env node
// Post-install smoke check on the REAL panel: the Live tiles of snapshot-only cameras (no NVR card) show a current
// picture, keep refreshing it about every 16 s while visible, and say how old it is when it is old.
// Usage: node dev/smoke/live-pictures.mjs [--size 1280x1500] [--wait 45] [--local]
//   It uses the bundle Home Assistant serves (the installed one); --local serves the newest bundle in custom_components/kestrel/frontend instead.
//   The tiles are the `article.camera-tile` of the Live page; each holds a `kestrel-live-picture` (found through the panel's shadow root).
// Needs the relay on 127.0.0.1:8124 (ha-relay-kestrel) and /data/home/tmp/ha-token. Prints no secrets (links are shown
// without their signature). Screenshot: $OUT (default /tmp/kestrel-smoke). Exits non-zero when a tile that has a usable
// picture link never gets a picture, or a picture that did load is never refreshed.
import { chromium } from "playwright-core";
import { mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const argv = process.argv.slice(2);
const flag = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i < 0 ? fallback : (argv[i + 1]?.startsWith("--") || argv[i + 1] === undefined ? true : argv[i + 1]); };
const base = String(flag("base", process.env.KESTREL_BASE ?? "http://127.0.0.1:8124"));
const tokenFile = String(flag("token-file", process.env.KESTREL_TOKEN_FILE ?? "/data/home/tmp/ha-token"));
const [W, H] = String(flag("size", "1280x1500")).split("x").map(Number);
const WAIT_MS = Number(flag("wait", 45)) * 1000;
const OUT = process.env.OUT ?? "/tmp/kestrel-smoke";
mkdirSync(OUT, { recursive: true });

function newestBundle() {
  const dir = join(root, "../custom_components/kestrel/frontend");
  return readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => join(dir, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader"] });
const touch = W < 800;
const context = await browser.newContext({ viewport: { width: W, height: H }, hasTouch: touch, isMobile: touch, deviceScaleFactor: touch ? 2 : 1 });
const token = readFileSync(tokenFile, "utf8").trim();
await context.addInitScript(([secret, origin]) => {
  try { if (!localStorage.getItem("hassTokens")) localStorage.setItem("hassTokens", JSON.stringify({ access_token: secret, token_type: "Bearer", expires_in: 1800, hassUrl: origin, clientId: `${origin}/`, expires: Date.now() + 365 * 864e5, refresh_token: "" })); } catch { /* a page without storage */ }
}, [token, base]);
if (flag("local", false)) {
  const body = readFileSync(newestBundle());
  await context.route("**/kestrel-static/kestrel.*.js*", (route) => route.fulfill({ status: 200, contentType: "application/javascript", body }));
}
const page = await context.newPage();
const errors = [];
page.on("console", (m) => { if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) errors.push(m.text().slice(0, 200)); });
page.on("pageerror", (e) => { if (e.name || e.stack || String(e.message) !== "closed") errors.push(`pageerror: ${String(e).slice(0, 200)}`); }); // Scrypted's bare "closed" rejections aren't the panel's

// Every request for a live picture, without its signature.
const requests = new Map();
const unsigned = (url) => new URL(url).pathname;
page.on("response", (response) => {
  if (!response.url().includes("/media/live/")) return;
  const key = unsigned(response.url());
  const row = requests.get(key) ?? { statuses: [], at: [] };
  row.statuses.push(response.status());
  row.at.push(Date.now());
  requests.set(key, row);
});

const HELPERS = "window.__deep = (r, s, o = []) => { r.querySelectorAll(s).forEach((e) => o.push(e)); r.querySelectorAll('*').forEach((e) => e.shadowRoot && window.__deep(e.shadowRoot, s, o)); return o; };";
await page.goto(`${base}/kestrel/live`, { waitUntil: "domcontentloaded" });
await page.evaluate(HELPERS);
await page.waitForFunction(() => window.__deep(document, "kestrel-panel")[0]?.shadowRoot.querySelector(".camera-tile"), null, { timeout: 60000 });
console.log("bundle in use:", flag("local", false) ? `${newestBundle().split("/").pop()} (newest local)` : await page.evaluate(() => performance.getEntriesByType("resource").map((e) => e.name).filter((n) => /kestrel-static\/kestrel\./.test(n)).map((n) => n.split("/").pop()).join(" ")));

const snapshot = () => page.evaluate(() => window.__deep(document, "kestrel-panel")[0].shadowRoot.querySelectorAll("kestrel-live-picture")).then(() => page.evaluate(() => [...window.__deep(document, "kestrel-panel")[0].shadowRoot.querySelectorAll("kestrel-live-picture")].map((p) => {
  const r = p.getBoundingClientRect();
  const src = p.src ?? "";
  return {
    label: (p.alt ?? "").replace(/ latest picture$/, ""),
    link: src === "" ? "none" : /^(?:https?:)?\/\/|^\//.test(src) ? "signed" : "bare path",
    path: src.split("?")[0],
    onScreen: r.bottom > 0 && r.top < innerHeight && r.width > 0,
    shown: p.shadowRoot.querySelector("img")?.src.startsWith("blob:") ?? false,
    placeholder: p.shadowRoot.querySelector(".empty span")?.textContent ?? null,
    age: p.shadowRoot.querySelector(".age")?.textContent ?? null,
  };
})));

const started = Date.now();
let rows = await snapshot();
const settled = (list) => list.filter((r) => r.onScreen && r.link === "signed").every((r) => r.shown && (requests.get(r.path)?.statuses.length ?? 0) >= 2 || (requests.get(r.path)?.statuses.every((s) => s >= 400) && (requests.get(r.path)?.statuses.length ?? 0) >= 2));
while (Date.now() - started < WAIT_MS && !(rows.length && settled(rows))) {
  await page.waitForTimeout(1000);
  rows = await snapshot();
}
await page.screenshot({ path: `${OUT}/live-pictures-${W}x${H}.png` });

let failed = 0;
console.log(`\n${rows.length} snapshot-only tile(s), ${rows.filter((r) => r.onScreen).length} on screen, after ${Math.round((Date.now() - started) / 1000)} s:`);
for (const row of rows) {
  const seen = requests.get(row.path);
  const asked = seen ? `${seen.statuses.length} request(s) [${seen.statuses.join(",")}]` : "no requests";
  const gaps = seen && seen.at.length > 1 ? `, gaps ${seen.at.slice(1).map((t, i) => Math.round((t - seen.at[i]) / 100) / 10).join("/")} s` : "";
  console.log(`  ${row.label.padEnd(18)} link=${row.link.padEnd(9)} ${row.onScreen ? "on screen " : "off screen"} ${row.shown ? `picture${row.age ? ` (${row.age})` : ""}` : `placeholder "${row.placeholder}"`}; ${asked}${gaps}`);
  if (!row.onScreen) continue;
  if (row.link !== "signed") { console.log("    note: no usable picture link yet (the camera list carries none, or an unsigned path the integration has not signed); the tile shows its placeholder and asks for nothing"); if (seen) { console.log("    FAIL: it asked for a picture anyway"); failed += 1; } continue; }
  if (!row.shown && !seen?.statuses.some((s) => s >= 400)) { console.log("    FAIL: no picture arrived"); failed += 1; }
  else if (row.shown && (seen?.statuses.length ?? 0) < 2) { console.log(`    FAIL: shown once but never refreshed within ${Math.round(WAIT_MS / 1000)} s`); failed += 1; }
}
if (errors.length) { console.log(`\nconsole errors: ${[...new Set(errors)].join(" | ")}`); failed += 1; } else console.log("\nconsole errors: none");
console.log(failed ? `\n${failed} problem(s)` : "\nLive pictures OK");
await browser.close();
process.exit(failed ? 1 : 0);
