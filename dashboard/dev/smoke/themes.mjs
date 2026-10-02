// Screenshots of the REAL panel in two Home Assistant themes (Neumorphism light = flat light, Caule Black Blue Glass = glass dark)
// at 390 and 1280 px and at the Echo Show size 960x480 (TOUCH, Home Assistant's sidebar hidden), in an isolated browser context,
// so the user's own theme is never touched: Live, Wildlife, a species sheet, a visit and the AI check-up. Prints, per size and
// theme, which device layout the shell chose (profile / navigation) and any console errors; the pictures are for looking at.
// Usage: node dev/smoke/themes.mjs [--local]   (OUT=/some/dir, KESTREL_VISIT=<visit id>). Same prerequisites as final-notfound.mjs.
// It uses the bundle Home Assistant serves (the installed one); --local serves the newest bundle in
// custom_components/kestrel/frontend instead (request interception).
import { chromium } from 'playwright-core';
import { readFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
const out = process.env.OUT ?? '/tmp/kestrel-themes';
mkdirSync(out, { recursive: true });
const local = process.argv.includes('--local');
const dir = '/data/home/Kestrel/custom_components/kestrel/frontend/';
const newest = () => readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => dir + f).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
const bundle = local ? readFileSync(newest()) : null;
const token = readFileSync('/data/home/tmp/ha-token', 'utf8').trim();
const base = 'http://127.0.0.1:8124';
const RACCOON = process.env.KESTREL_VISIT ?? '43030c7c-38d3-47fc-9dc8-0374bb5cc7fc'; // any visit id that still exists
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required', '--enable-unsafe-swiftshader'] });
// In-page helpers: the panel's shadow root, the showing page of its view stack (switched-off pages keep their old content), the open species sheet.
const HELPERS = `const deep = (r, s, o = []) => { r.querySelectorAll(s).forEach((e) => o.push(e)); r.querySelectorAll('*').forEach((e) => e.shadowRoot && deep(e.shadowRoot, s, o)); return o; };
const host = () => deep(document, 'kestrel-panel')[0];
const view = (id) => { const stack = host()?.shadowRoot?.querySelector('kestrel-lu-view-stack'); return stack?.querySelector(':scope > [data-view="' + (id ?? stack.current) + '"]') ?? null; };
const sheet = () => host()?.shadowRoot?.querySelector('kestrel-species-sheet')?.shadowRoot?.querySelector('kestrel-lu-sheet[layer="species"]') ?? null;`;
const themes = [{ key: 'flat-light', theme: 'Neumorphism', dark: false }, { key: 'glass-dark', theme: 'Caule Black Blue Glass', dark: true }];
const sizes = [{ w: 390, h: 844, touch: true }, { w: 1280, h: 800, touch: false }, { w: 960, h: 480, touch: true, hideSidebar: true }];
const report = [];
for (const size of sizes) {
  for (const t of themes) {
    const context = await browser.newContext({ viewport: { width: size.w, height: size.h }, hasTouch: size.touch, isMobile: size.touch, deviceScaleFactor: 1 });
    await context.addInitScript(([secret, b, hide]) => { try { if (!localStorage.getItem('hassTokens')) localStorage.setItem('hassTokens', JSON.stringify({ access_token: secret, token_type: 'Bearer', expires_in: 1800, hassUrl: b, clientId: b + '/', expires: Date.now() + 365 * 864e5, refresh_token: '' })); if (hide) localStorage.setItem('dockedSidebar', JSON.stringify('always_hidden')); } catch {} }, [token, base, Boolean(size.hideSidebar)]);
    if (bundle) await context.route('**/kestrel-static/kestrel.*.js*', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: bundle }));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => { if (e.name || e.stack || String(e.message) !== 'closed') errors.push(String(e).slice(0, 200)); }); // Scrypted's bare "closed" rejections aren't the panel's
    page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text().slice(0, 200)); });
    const open = async (path, ready) => {
      await page.goto(base + path, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(`(() => { ${HELPERS} const h = host(); return Boolean(h && h.shadowRoot && ${ready}); })()`, null, { timeout: 60000 });
      if (t.theme && !(await page.evaluate(() => window.__themed))) {
        // Worn on the PAGE only (what the setting does to the page, minus the save): Home Assistant's `settheme` event would overwrite the theme
        // profile it keeps on the server for the token's user. A fresh load wears the profile's theme again, so every open() does this.
        const worn = await page.evaluate(([name, dark]) => {
          const ha = document.querySelector('home-assistant');
          if (!ha || typeof ha._updateHass !== 'function' || typeof ha._applyTheme !== 'function') return false;
          window.__themed = true;
          ha._updateHass({ selectedTheme: { ...ha.hass.selectedTheme, theme: name, dark } });
          ha._applyTheme(false);
          return true;
        }, [t.theme, t.dark]);
        if (!worn) throw new Error("this Home Assistant does not offer the page's theme hooks (_updateHass, _applyTheme)");
      }
      await page.waitForTimeout(1800);
    };
    const shot = (name) => page.screenshot({ path: `${out}/${t.key}-${size.w}x${size.h}-${name}.png` });
    await open('/kestrel/live', "view('live')?.querySelector('.camera-name')");
    const layout = await page.evaluate(`(() => { ${HELPERS} const s = host().shadowRoot.querySelector('kestrel-lu-app-shell'); return s.getAttribute('data-lu-profile') + ' / nav ' + s.getAttribute('data-lu-nav') + (s.hasAttribute('data-lu-touch') ? ' / touch' : '') + (s.hasAttribute('data-lu-short') ? ' / short' : ''); })()`);
    await shot('live');
    await open('/kestrel/wildlife', "view('wildlife')?.querySelector('.species-name')");
    await shot('wildlife');
    // a species sheet with recordings
    const tapped = await page.evaluate(`(() => { ${HELPERS} const t = [...view('wildlife').querySelectorAll('button.species-tile')].find((x) => x.getAttribute('aria-label').startsWith('Blue Jay.')); if (!t) return false; t.click(); return true; })()`);
    await page.waitForFunction(`(() => { ${HELPERS} const s = sheet(); return Boolean(s && s.hasAttribute('open') && s.querySelector('kestrel-lu-audio-list, kestrel-lu-media-rail')); })()`, null, { timeout: 15000 }).catch(() => undefined);
    await page.waitForTimeout(2500);
    const sheetOpen = await page.evaluate(`(() => { ${HELPERS} return Boolean(sheet()?.hasAttribute('open')); })()`);
    await shot('sheet');
    await open('/kestrel/visit?v=' + RACCOON, "view('visit')?.querySelector('.visit-title-row, kestrel-lu-state[kind=empty]')");
    await page.waitForTimeout(1500);
    await shot('visit');
    await open('/kestrel/insights', "view('insights')?.querySelector('.health-tile')");
    await shot('insights');
    report.push(`${size.w}x${size.h} ${t.key}: ${layout}; species sheet ${tapped ? (sheetOpen ? 'opened' : 'DID NOT OPEN') : 'no Blue Jay tile'}; ${errors.slice(0, 3).join(' | ') || 'no console errors'}`);
    await context.close();
  }
}
console.log(report.join('\n'));
console.log(`pictures in ${out}${local ? ' (newest local bundle)' : ' (installed bundle)'}`);
await browser.close();
process.exit(0);
