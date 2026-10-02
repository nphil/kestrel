// Post-install smoke check on the REAL panel, using the bundle Home Assistant actually serves (nothing intercepted; --local serves the
// newest bundle in custom_components/kestrel/frontend instead, to check a build before it is installed).
// An unknown visit id must show the friendly "merged or removed" page after exactly one kestrel/visit request; /kestrel/visit
// with no id must show "No visit selected" and make none; no console errors. Usage: node dev/smoke/final-notfound.mjs [--local]
// Both messages are the headings of a `kestrel-lu-state` in the visit page of the view stack (found through the panel's shadow roots).
// Needs the relay on 127.0.0.1:8124 (ha-relay-kestrel) and /data/home/tmp/ha-token. Prints no secrets. Screenshot: $OUT (default /tmp/kestrel-smoke).
import { chromium } from 'playwright-core';
import { readFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
const OUT = process.env.OUT ?? '/tmp/kestrel-smoke';
mkdirSync(OUT, { recursive: true });
const token = readFileSync('/data/home/tmp/ha-token', 'utf8').trim();
const base = 'http://127.0.0.1:8124';
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
await context.addInitScript(([secret, b]) => { try { if (!localStorage.getItem('hassTokens')) localStorage.setItem('hassTokens', JSON.stringify({ access_token: secret, token_type: 'Bearer', expires_in: 1800, hassUrl: b, clientId: b + '/', expires: Date.now() + 365 * 864e5, refresh_token: '' })); } catch {} }, [token, base]);
const errors = []; const scripts = new Set();
if (process.argv.includes('--local')) {
  const dir = '/data/home/kestrel/custom_components/kestrel/frontend/';
  const newest = readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => dir + f).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  const body = readFileSync(newest);
  scripts.add(`(newest local) ${newest.split('/').pop()}`);
  await context.route('**/kestrel-static/kestrel.*.js*', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body }));
}
const page = await context.newPage();
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
page.on('request', (r) => { const u = r.url(); if (/kestrel-static\/kestrel\./.test(u)) scripts.add(u.replace(base, '')); });
const frames = [];
page.on('websocket', (ws) => ws.on('framesent', (f) => { try { const m = JSON.parse(f.payload); if (/^kestrel\/visit$/.test(m.type)) frames.push(m); } catch {} }));
// A state (empty / error ...) of the visit page whose heading contains `needle`.
const text = async (needle) => page.waitForFunction((n) => { const deep = (r, s, o = []) => { r.querySelectorAll(s).forEach((e) => o.push(e)); r.querySelectorAll('*').forEach((e) => e.shadowRoot && deep(e.shadowRoot, s, o)); return o; }; const h = deep(document, 'kestrel-panel')[0]; const visit = h?.shadowRoot?.querySelector('kestrel-lu-view-stack > [data-view="visit"]'); return Boolean(visit && [...visit.querySelectorAll('kestrel-lu-state')].some((s) => (s.getAttribute('heading') ?? '').includes(n))); }, needle, { timeout: 30000 }).then(() => true, () => false);
await page.goto(base + '/kestrel/visit?v=does-not-exist', { waitUntil: 'domcontentloaded' });
console.log('bundle requested:', [...scripts].join(' '));
console.log('friendly state shown:', await text('merged or removed'));
await page.waitForTimeout(800);
console.log('kestrel/visit requests sent:', frames.map((f) => JSON.stringify({ visit_id: f.visit_id })).join(' ') || 'none');
await page.screenshot({ path: `${OUT}/installed-gone-390.png` });
await page.goto(base + '/kestrel/visit', { waitUntil: 'domcontentloaded' });
console.log('no ?v= shows "No visit selected":', await text('No visit selected'));
console.log('requests after no-id page:', frames.length);
console.log('console errors:', errors.length ? errors.join(' | ') : 'none');
await browser.close();
process.exit(0);
