// Post-install smoke check on the REAL panel, installed bundle (nothing intercepted): Live sighting chip -> visit page ->
// system Back restores Live at the same scroll; a focused camera is still focused after Back from a visit; no console errors.
// Usage: node dev/smoke/final-live-back.mjs [width height]   (default 390 844). Same prerequisites as final-notfound.mjs.
import { chromium } from 'playwright-core';
import { readFileSync, mkdirSync } from 'node:fs';
const OUT = process.env.OUT ?? '/tmp/kestrel-smoke';
mkdirSync(OUT, { recursive: true });
const token = readFileSync('/data/home/tmp/ha-token', 'utf8').trim();
const base = 'http://127.0.0.1:8124';
const W = Number(process.argv[2] || 390), H = Number(process.argv[3] || 844);
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ viewport: { width: W, height: H }, hasTouch: W < 800, isMobile: W < 800, deviceScaleFactor: W < 800 ? 2 : 1 });
await context.addInitScript(([secret, b]) => { try { if (!localStorage.getItem('hassTokens')) localStorage.setItem('hassTokens', JSON.stringify({ access_token: secret, token_type: 'Bearer', expires_in: 1800, hassUrl: b, clientId: b + '/', expires: Date.now() + 365 * 864e5, refresh_token: '' })); } catch {} }, [token, base]);
const page = await context.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
page.on('pageerror', (e) => errors.push(`pageerror ${String(e).slice(0, 160)}`));
const eval$ = (fn, arg) => page.evaluate(`(() => { const deep = (r, s, o = []) => { r.querySelectorAll(s).forEach((e) => o.push(e)); r.querySelectorAll('*').forEach((e) => e.shadowRoot && deep(e.shadowRoot, s, o)); return o; }; const host = deep(document, 'kestrel-panel')[0]; const sr = host.shadowRoot; const arg = ${JSON.stringify(arg ?? null)}; return (${fn})(host, sr, deep, arg); })()`);
await page.goto(base + '/kestrel/live', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => { const deep = (r, s, o = []) => { r.querySelectorAll(s).forEach((e) => o.push(e)); r.querySelectorAll('*').forEach((e) => e.shadowRoot && deep(e.shadowRoot, s, o)); return o; }; const h = deep(document, 'kestrel-panel')[0]; return h && h.shadowRoot.querySelector('.chip-button'); }, null, { timeout: 60000 });
await page.waitForTimeout(2500);
const bundle = await page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /kestrel-static\/kestrel\./.test(n)).map((n) => n.split('/').pop()).join(' '));
console.log(`${W}x${H} bundle in use:`, bundle);

// 1. scroll Live a little, remember where we are
await page.evaluate(() => window.scrollTo(0, 420));
await page.waitForTimeout(500);
const y0 = await page.evaluate(() => Math.round(window.scrollY));
const chipLabel = await eval$((h, sr) => { const c = [...sr.querySelectorAll('.chip-button')].find((b) => { const r = b.getBoundingClientRect(); return r.top > 0 && r.bottom < innerHeight; }) ?? sr.querySelector('.chip-button'); c.dataset.testChip = '1'; c.scrollIntoView({ block: 'nearest' }); return c.getAttribute('aria-label'); });
await page.waitForTimeout(400);
const yChip = await page.evaluate(() => Math.round(window.scrollY));
console.log('scrolled to', y0, 'then to the chip at', yChip, '-', chipLabel);

// 2. tap the sighting chip -> visit page
const t0 = Date.now();
await eval$((h, sr) => sr.querySelector('[data-test-chip]').click());
await page.waitForFunction(() => location.search.includes('v='), null, { timeout: 8000 });
const gotVisit = await page.waitForFunction(() => { const deep = (r, s, o = []) => { r.querySelectorAll(s).forEach((e) => o.push(e)); r.querySelectorAll('*').forEach((e) => e.shadowRoot && deep(e.shadowRoot, s, o)); return o; }; const h = deep(document, 'kestrel-panel')[0]; const v = h.shadowRoot.querySelector('.visit-view'); return v && !v.querySelector('.bone') && v.textContent.length > 40; }, null, { timeout: 15000 }).then(() => Date.now() - t0, () => -1);
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
const focused = await eval$((h, sr) => { const tile = [...sr.querySelectorAll('.camera-tile')].find((t) => t.querySelector('.chip-button')); const b = tile.querySelector('.camera-focus'); const name = b.getAttribute('aria-label'); b.click(); return name; });
await page.waitForFunction(() => { const deep = (r, s, o = []) => { r.querySelectorAll(s).forEach((e) => o.push(e)); r.querySelectorAll('*').forEach((e) => e.shadowRoot && deep(e.shadowRoot, s, o)); return o; }; const h = deep(document, 'kestrel-panel')[0]; return h.shadowRoot.querySelector('.focused-camera'); }, null, { timeout: 8000 });
await page.waitForTimeout(600);
const hasChip = await eval$((h, sr) => Boolean(sr.querySelector('.focused-camera .chip-button')));
console.log('focused:', focused, '- chip on the focused page:', hasChip);
if (hasChip) {
  await eval$((h, sr) => sr.querySelector('.focused-camera .chip-button').click());
  await page.waitForFunction(() => location.search.includes('v='), null, { timeout: 8000 });
  await page.waitForTimeout(1200);
  await page.goBack();
  await page.waitForTimeout(900);
  const stillFocused = await eval$((h, sr) => ({ focusedShown: Boolean(sr.querySelector('.focused-camera')), heading: sr.querySelector('.focused-camera h1')?.textContent ?? null }));
  console.log('after Back from the visit:', JSON.stringify(stillFocused));
}
console.log('console errors:', errors.length ? errors.join(' | ') : 'none');
await browser.close();
process.exit(0);
