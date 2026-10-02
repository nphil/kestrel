// Screenshots of the REAL panel (local bundle) in two Home Assistant themes at 390 and 1280 px, in an isolated browser
// context, so the user's own theme is never touched: Live, Wildlife, a species sheet and a visit, light flat vs dark glass.
// Usage: node dev/smoke/themes.mjs   (OUT=/some/dir, KESTREL_VISIT=<visit id>). Same prerequisites as final-notfound.mjs.
import { chromium } from 'playwright-core';
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
const out = process.env.OUT ?? '/tmp/kestrel-themes';
mkdirSync(out, { recursive: true });
const dir = '/data/home/kestrel/custom_components/kestrel/frontend/';
const bundle = readFileSync(dir + readdirSync(dir).find((f) => f.endsWith('.js')));
const token = readFileSync('/data/home/tmp/ha-token', 'utf8').trim();
const base = 'http://127.0.0.1:8124';
const RACCOON = process.env.KESTREL_VISIT ?? '43030c7c-38d3-47fc-9dc8-0374bb5cc7fc'; // any visit id that still exists
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required', '--enable-unsafe-swiftshader'] });
const deep = `const deep = (r, s, o = []) => { r.querySelectorAll(s).forEach((e) => o.push(e)); r.querySelectorAll('*').forEach((e) => e.shadowRoot && deep(e.shadowRoot, s, o)); return o; }; const host = () => deep(document, 'kestrel-panel')[0];`;
const themes = [{ key: 'flat-light', theme: 'Neumorphism', dark: false }, { key: 'glass-dark', theme: 'Caule Black Blue Glass', dark: true }];
const sizes = [{ w: 390, h: 844, touch: true }, { w: 1280, h: 800, touch: false }];
const report = [];
for (const size of sizes) {
  for (const t of themes) {
    const context = await browser.newContext({ viewport: { width: size.w, height: size.h }, hasTouch: size.touch, isMobile: size.touch, deviceScaleFactor: 1 });
    await context.addInitScript(([secret, b]) => { try { if (!localStorage.getItem('hassTokens')) localStorage.setItem('hassTokens', JSON.stringify({ access_token: secret, token_type: 'Bearer', expires_in: 1800, hassUrl: b, clientId: b + '/', expires: Date.now() + 365 * 864e5, refresh_token: '' })); } catch {} }, [token, base]);
    await context.route('**/kestrel-static/kestrel.*.js*', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: bundle }));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
    page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text().slice(0, 200)); });
    const open = async (path, ready) => {
      await page.goto(base + path, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(`(() => { ${deep} const h = host(); return h && h.shadowRoot && ${ready}; })()`, null, { timeout: 60000 });
      if (t.theme && !(await page.evaluate(() => window.__themed))) {
        await page.evaluate(([name, dark]) => { window.__themed = true; document.querySelector('home-assistant').dispatchEvent(new CustomEvent('settheme', { detail: { theme: name, dark }, bubbles: true, composed: true })); }, [t.theme, t.dark]);
      }
      await page.waitForTimeout(1800);
    };
    const shot = (name) => page.screenshot({ path: `${out}/${t.key}-${size.w}-${name}.png` });
    await open('/kestrel/live', "h.shadowRoot.querySelector('.camera-name')");
    await shot('live');
    await open('/kestrel/wildlife', "h.shadowRoot.querySelector('.species-name')");
    await shot('wildlife');
    // a species sheet with recordings
    await page.evaluate(`(() => { ${deep} const t = [...host().shadowRoot.querySelectorAll('.species-tile')].find((x) => x.getAttribute('aria-label').startsWith('Blue Jay.')); t.click(); })()`);
    await page.waitForTimeout(2500);
    await shot('sheet');
    await open('/kestrel/visit?v=' + RACCOON, "h.shadowRoot.querySelector('.visit-title-row, .empty-state')");
    await page.waitForTimeout(1500);
    await shot('visit');
    report.push(`${size.w} ${t.key}: ${errors.slice(0, 3).join(' | ') || 'no console errors'}`);
    await context.close();
  }
}
console.log(report.join('\n'));
await browser.close();
process.exit(0);
