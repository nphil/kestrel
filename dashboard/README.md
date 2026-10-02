# Kestrel dashboard

Lit 3 + strict TypeScript, bundled by esbuild into `../custom_components/kestrel/frontend/kestrel.<hash>.js`
(budget: 80 KB gzipped; the build fails above it).

| Command | What it does |
|---|---|
| `npm run typecheck` | Strict TypeScript, no emit. |
| `npm run build` | Production bundle; the integration serves whatever hashed file is in that folder. |
| `npm run build:dev` then `npm run serve:dev` | Local fixture page at <http://127.0.0.1:8765/dev/index.html> (fake cameras, species, visits and recordings; no Home Assistant). |
| `node dev/perf-check.mjs` | Release gate. Measures the real panel (or `--target harness`) on every device size against the standing requirements and exits non-zero when one fails. Needs `npm install --include=dev`. Run it before each release; the options are listed at the top of the file. |

## Layout

- `src/ui/` generic Lucent building blocks: sheet, section, media rail, audio list, segmented control, lazy image and
  audio, press tracking, panel profile. They read `--lu-*` tokens only and know nothing about Kestrel's data.
- `src/components/` Kestrel glue: the panel (`kestrel-cameras`), the species sheet, the live player.
- `src/styles/tokens.ts` the one token layer. Home Assistant's theme supplies every colour; `PanelProfile` sets
  `data-lu-profile` (phone, tablet, desktop, smart, ha) from the panel's own size and input, and the tokens follow.
- `src/vocab.ts` the single icon and word for "on camera" (video) and "heard" (waveform), used everywhere.

## Rules that came out of measuring

- **Pressed feedback is a wash, or a veil over a picture, never a scale.** Changing a transform on press makes the
  browser create a graphics layer every time; a trace of the real panel showed 6-13 ms of main-thread work per press
  for it (species tile 16 ms), against 1.5-5 ms for a wash. The pressed rule also sets `transition: none` so the
  feedback lands in the first frame; the resting rule keeps a short colour transition for the release.
- **Timings need a quiet machine.** `perf-check` prints the host load before and after each size and marks the size
  PROVISIONAL when either is 8 or more; wall-clock presses swing between 30 and 400 ms on a busy host. To see what
  the panel itself costs regardless of load, trace a press and add up the main thread's thread-time
  (`UpdateLayoutTree`, `Layout`, `PrePaint`, `Paint`, `Layerize`, `Commit` within 160 ms of the `pointerdown`).
- Press timing never scrolls first (a centred scroll measures the new tiles' images, not the control), and every
  control press is preceded by an inert press in the same state, so "the machine is slow right now" is measured
  next to the control instead of at some other moment.
