# Kestrel dashboard

Lit 3 + strict TypeScript, bundled by esbuild into `../custom_components/kestrel/frontend/kestrel.<hash>.js`
(budget: 80 KB gzipped; the build fails above it; about 75 KB today).

| Command | What it does |
|---|---|
| `npm run typecheck` | Strict TypeScript, no emit. |
| `npm run build` | Production bundle; the integration serves whatever hashed file is in that folder. |
| `node dev/build.mjs` then `node dev/serve.mjs [port]` | The fixture harness: the real `<kestrel-panel>` inside a small Home Assistant (docked sidebar or drawer, the four real themes, a `hass` that can drop and restart) with fake cameras, species, visits and recordings, at <http://127.0.0.1:8765/kestrel/live>. No Home Assistant needed. `serve.mjs` is a tiny no-cache static server with the single-page fallback for `/kestrel/**` (it replaces `npm run serve:dev`, which cannot do that). Details below. |
| `node dev/perf-check.mjs` | Release gate. Measures the real panel (newest local bundle; `--installed` for the served one) or `--target harness` (the fixture page of `dev/serve.mjs`) on every device size and exits non-zero when one fails: press feedback 50 ms, tab switch 100/300 ms, open 1 s, **sheet open 220 ms** (tap to the first frame with the species sheet or the "Wrong?" picker on screen and entering; the 220 ms enter motion itself is reported, not judged), **Back closes the top layer 100 ms** (`history.back()` to the first frame in which the open sheet begins to close, species sheet and picker), scroll, audio, video, Back/scroll restore, 44 px targets, hover-only rules, shell profile/rail layout. Wall-clock misses are PROVISIONAL (printed, not failed) while the host load is 8 or more; `--correctness-only` prints but does not judge any timing. Needs `npm install --include=dev`. The options are listed at the top of the file. |
| `nice -n 15 node dev/press-cost.mjs` | What a press costs the panel itself, from a browser trace (main-thread thread-time), so it holds on a busy machine where wall-clock timing does not. Real panel through the relay; compares each control (found through the app shell, view stack and sheet) with an inert press; budget 8 ms at 1x CPU. |
| `node dev/smoke/final-notfound.mjs`, `final-live-back.mjs [w h]`, `live-pictures.mjs [--wait 45] [--local]`, `themes.mjs [--local]` | Post-install smoke checks on the real panel, in an isolated browser context (they use the bundle Home Assistant serves; `--local` serves the newest local one): friendly merged/removed page, Live chip -> visit -> Back restores scroll and the focused camera, snapshot-only cameras show a picture that refreshes about every 16 s, flat-light vs glass-dark screenshots (Live, Wildlife, species sheet, visit, AI check-up) at 390, 1280 and the 960x480 touch Echo Show size. Need the relay on 127.0.0.1:8124 and the token file; print no secrets. |

## Fixture harness (`dev/`)

`dev/harness.ts` mounts the real `kestrel-panel` the way Home Assistant does: `dev/ha/` holds an `ha-panel-custom` stand-in (gives the panel `hass`,
`narrow` (<= 870 px), `route`, `panel`; pads it by the safe-area insets; offers `navigate()`; destroys the panel when the address leaves `/kestrel` and
creates a new one when it comes back), the sidebar frame (docked 256 px above 870 px, otherwise a drawer opened by `hass-toggle-menu`; `hass-kiosk-mode`),
`ha-icon`/`ha-card` stand-ins, and Home Assistant's real Neumorphism / Frosted Glass theme data (copied from lucent-ha's `dev/`, MIT). `hass` is immutable:
every change (connection, theme, sidebar, kiosk) builds a new object.

Address parameters (read on the first load, kept for the tab, removed from the address): `?theme=flat-light|flat-dark|glass-light|glass-dark`
(default `flat-light`), `toolbar=1` (small button bar), `sidebar=docked|auto|always_hidden`, `kiosk=1`, `safe=top,right,bottom,left` (px), `latency=ms`
(fake server delay, default 40), `epoch=N`.

`window.__ha` drives it: `setTheme(name)`, `disconnect()`, `reconnect()`, `restart({ downMs = 1500 })` (epoch + 1, socket drops now, returns after
`downMs`), `epoch`, `hass`, `theme`, `subscriptions`, `setSidebar(mode)`, `setKiosk(bool)`. `window.__emit({ type, data })` pushes an event as the
integration would. While the socket is down `callWS` fails like home-assistant-js-websocket (bare `3` for a new call, `{ code: 3, message: "Connection lost" }`
for one in flight). Media links are `/api/kestrel/media/<kind>/<id>?authSig=e<epoch>`; links already handed out keep their epoch, so a test's request
interceptor can answer 401 for the old ones, as a restarted Home Assistant does (`window.__setEpoch(epoch)` is called when it is defined).

Smoke scripts (need `node dev/build.mjs` first; each takes `--size WxH` and `--theme name`, prints one PASS/FAIL/SKIP line per check, exits non-zero on a
failure; screenshots in `/tmp/kestrel-smoke/`). Run them as `taskset -c 0-4,8-12 nice -n 15 node dev/smoke/<script> --size 390x844`:

| Script | Proves |
|---|---|
| `dev/smoke/fixture-back.mjs` | Back / Escape order: species sheet is URL-backed (`?s=`), picker and help sheets add one entry and Back closes only them, tabs replace the entry and leaving Live adds one marker entry. Counts entries with the Navigation API. |
| `dev/smoke/fixture-scroll.mjs` | Each tab keeps its own scroll offset; Wildlife scrolled deep survives sheet -> visit -> Back, Back; a visit opened again with another id starts at the top. |
| `dev/smoke/fixture-reconnect.mjs` | Restart of Home Assistant: last data stays and a quiet "Reconnecting" strip shows; within 5 s every picture, audio link and video link carries the new epoch and is loaded; same after a reload that still has the old saved copy. Counts requests per epoch. |
| `dev/smoke/real-matrix.mjs` | Not a fixture script: proves the user-visible requirements on the REAL Home Assistant in the shared browser (5 sizes x flat-light / glass-dark = 10 cells, one PASS/FAIL/SKIP line per check, a final table, screenshots in `/tmp/kestrel-matrix/`). `node dev/smoke/real-matrix.mjs --bundle local\|installed --sizes phone,smart,tablet,desktop,wide --themes flat-light,glass-dark` (`local` serves the newest bundle in `custom_components/kestrel/frontend` into the real page; `installed` tests what HA serves). Needs the relay on 127.0.0.1:8124 and the shared browser (CDP 127.0.0.1:43977); never writes real data; restores the browser's size, touch, route and theme at the end. Timings are PROVISIONAL on a busy host. |

`dev/smoke/lib/fixture.mjs` is the shared part (server, chromium, the 401 interceptor, deep query helper, console-error collector).

## Layout

The panel is built on the shared toolkit [lucent-ha](https://github.com/nphil/lucent-ha) (`package.json` pins a release tag): the app shell (pinned bar,
menu button, navigation that follows the panel's size), view stack (each tab keeps its scroll), sheet, image, audio list and the rest come from it,
registered once under the `kestrel-lu-` prefix in `src/main.ts`. Colours, spacing and motion are `--lu-*` tokens that follow the live Home Assistant theme.

- `src/components/` Kestrel glue: the panel (`kestrel-cameras`), the species sheet, the live player.
- `src/ui/` the few Kestrel-only building blocks: self-refreshing live picture, the heard-visit hero.
- `src/recovery.ts` + the recovery code in `kestrel-cameras`: after Home Assistant restarts its signed media links stop working; the panel asks the server
  about one link, and if it is refused it drops every saved link, asks for fresh data and re-creates the audio players. Nothing is reloaded.
- `src/styles/panel.ts` the panel's own styles (tokens only).
- `src/vocab.ts` the single icon and word for "on camera" (video) and "heard" (waveform), used everywhere.

## Rules that came out of measuring

- **Pressed feedback is a wash, or a veil over a picture, never a scale.** Changing a transform on press makes the
  browser create a graphics layer every time; a trace of the real panel showed 6-13 ms of main-thread work per press
  for it (species tile 16 ms), against 1.5-5 ms for a wash. The pressed rule also sets `transition: none` so the
  feedback lands in the first frame; the resting rule keeps a short colour transition for the release.
- **Timings need a quiet machine.** `perf-check` prints the host load before and after each size and marks the size
  PROVISIONAL when either is 8 or more, and then no wall-clock miss (press, tabs, sheet open, Back closes the layer, ...) fails
  the run; they swing between 30 and 400 ms on a busy host. To see what
  the panel itself costs regardless of load, trace a press and add up the main thread's thread-time
  (`UpdateLayoutTree`, `Layout`, `PrePaint`, `Paint`, `Layerize`, `Commit` within 160 ms of the `pointerdown`).
- Press timing never scrolls first (a centred scroll measures the new tiles' images, not the control), and every
  control press is preceded by an inert press in the same state, so "the machine is slow right now" is measured
  next to the control instead of at some other moment.
