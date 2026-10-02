// Post-install smoke check on the REAL panel, installed bundle (nothing intercepted; --local serves the newest local bundle instead): Live sighting chip -> visit page ->
// system Back restores Live at the same scroll; a focused camera is still focused after Back from a visit; no console errors.
// The page itself scrolls (the app shell does not), and the view stack remembers each view's scroll position.
// Usage: node dev/smoke/final-live-back.mjs [width height] [--local]   (default 390 844). Same prerequisites as final-notfound.mjs.
import { chromium } from 'playwright-core';
import { readFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
const OUT = process.env.OUT ?? '/tmp/kestrel-smoke';
mkdirSync(OUT, { recursive: true });
const token = readFileSync('/data/home/tmp/ha-token', 'utf8').trim();
const base = 'http://127.0.0.1:8124';
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const W = Number(positional[0] || 390), H = Number(positional[1] || 844);
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ viewport: { width: W, height: H }, hasTouch: W < 800, isMobile: W < 800, deviceScaleFactor: W < 800 ? 2 : 1 });
await context.addInitScript(([secret, b]) => { try { if (!localStorage.getItem('hassTokens')) localStorage.setItem('hassTokens', JSON.stringify({ access_token: secret, token_type: 'Bearer', expires_in: 1800, hassUrl: b, clientId: b + '/', expires: Date.now() + 365 * 864e5, refresh_token: '' })); } catch {} }, [token, base]);
let localName = null;
if (process.argv.includes('--local')) {
  const dir = '/data/home/Kestrel/custom_components/kestrel/frontend/';
  const newest = readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => dir + f).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  const body = readFileSync(newest);
  localName = newest.split('/').pop();
  await context.route('**/kestrel-static/kestrel.*.js*', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body }));
}
const page = await context.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
page.on('pageerror', (e) => { if (e.name || e.stack || String(e.message) !== 'closed') errors.push(`pageerror ${String(e).slice(0, 160)}`); }); // Scrypted's bare "closed" rejections aren't the panel's
// In-page helpers: `view(id)` is a page of the panel's view stack (a page that was left stays in the document, switched off).
const HELPERS = `const deep = (r, s, o = []) => { r.querySelectorAll(s).forEach((e) => o.push(e)); r.querySelectorAll('*').forEach((e) => e.shadowRoot && deep(e.shadowRoot, s, o)); return o; }; const host = () => deep(document, 'kestrel-panel')[0]; const view = (id) => { const stack = host()?.shadowRoot?.querySelector('kestrel-lu-view-stack'); return stack?.querySelector(':scope > [data-view="' + (id ?? stack.current) + '"]') ?? null; };`;
const eval$ = (fn, arg) => page.evaluate(`(() => { ${HELPERS} const arg = ${JSON.stringify(arg ?? null)}; return (${fn})(view, arg); })()`);
const until = (cond, timeout = 15000) => page.waitForFunction(`(() => { ${HELPERS} return Boolean(${cond}); })()`, null, { timeout });
await page.goto(base + '/kestrel/live', { waitUntil: 'domcontentloaded' });
await until("view('live')?.querySelector('kestrel-lu-chip[interactive]')", 60000);
await page.waitForTimeout(2500);
const bundle = await page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /kestrel-static\/kestrel\./.test(n)).map((n) => n.split('/').pop()).join(' '));
console.log(`${W}x${H} bundle in use:`, localName ? `${localName} (newest local)` : bundle);

// 1. scroll Live a little, remember where we are
await page.evaluate(() => window.scrollTo(0, 420));
await page.waitForTimeout(500);
const y0 = await page.evaluate(() => Math.round(window.scrollY));
const chipLabel = await eval$((view) => { const chips = [...view('live').querySelectorAll('kestrel-lu-chip[interactive]')]; const c = chips.find((b) => { const r = b.getBoundingClientRect(); return r.top > 0 && r.bottom < innerHeight; }) ?? chips[0]; c.dataset.testChip = '1'; c.scrollIntoView({ block: 'nearest' }); return c.textContent.trim().replace(/\s+/g, ' '); });
await page.waitForTimeout(400);
const yChip = await page.evaluate(() => Math.round(window.scrollY));
console.log('scrolled to', y0, 'then to the chip at', yChip, '-', chipLabel);

// 2. tap the sighting chip -> visit page
const t0 = Date.now();
await eval$((view) => view('live').querySelector('[data-test-chip]').shadowRoot.querySelector('button.chip').click());
await page.waitForFunction(() => location.search.includes('v='), null, { timeout: 8000 });
const gotVisit = await until("view('visit')?.querySelector('.visit-title-row') && !view('visit').querySelector('kestrel-lu-state[kind=loading]')").then(() => Date.now() - t0, () => -1);
console.log('visit page content after', gotVisit, 'ms; url', await page.evaluate(() => location.pathname + location.search.replace(/v=[^&]+/, 'v=…')));
await page.screenshot({ path: `${OUT}/installed-chip-visit-${W}.png` });

// 3. system Back -> Live again, same scroll
await page.goBack();
await page.waitForTimeout(900);
const back = await page.evaluate(() => ({ y: Math.round(window.scrollY), path: location.pathname }));
console.log('after Back:', JSON.stringify(back), 'expected scroll', yChip, 'drift', Math.abs(back.y - yChip), 'px');

// 4. focus a camera, open its chip, Back keeps the focused camera
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(300);
const focused = await eval$((view) => { const tile = [...view('live').querySelectorAll('.camera-tile')].find((t) => t.querySelector('kestrel-lu-chip[interactive]')); const b = tile.querySelector('.camera-focus'); const name = b.getAttribute('aria-label'); b.click(); return name; });
await until("view('live')?.querySelector('.focused-camera')", 8000);
await page.waitForTimeout(600);
const hasChip = await eval$((view) => Boolean(view('live').querySelector('.focused-camera kestrel-lu-chip[interactive]')));
console.log('focused:', focused, '- chip on the focused page:', hasChip);
if (hasChip) {
  await eval$((view) => view('live').querySelector('.focused-camera kestrel-lu-chip[interactive]').shadowRoot.querySelector('button.chip').click());
  await page.waitForFunction(() => location.search.includes('v='), null, { timeout: 8000 });
  await page.waitForTimeout(1200);
  await page.goBack();
  await page.waitForTimeout(900);
  const stillFocused = await eval$((view) => ({ focusedShown: Boolean(view('live').querySelector('.focused-camera')), heading: view('live').querySelector('.focused-camera .focused-heading h2')?.textContent.trim() ?? null }));
  console.log('after Back from the visit:', JSON.stringify(stillFocused));
  await page.screenshot({ path: `${OUT}/installed-focused-back-${W}.png` });
}
console.log('console errors:', errors.length ? errors.join(' | ') : 'none');
await browser.close();
process.exit(0);
