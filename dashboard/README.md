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
