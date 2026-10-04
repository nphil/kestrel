import { BASE_CSS, SURFACE_CSS } from "lucent-ha";
import { css } from "lit";
import { HEARD_HERO_CSS } from "../ui/heard-hero.ts";

/** Kestrel's own layout on top of the toolkit: how its tiles, pages and the visit hero are put together. Colours, space,
 * type and motion are all `--lu-*` tokens from the shell (or card root) around it, so Home Assistant's theme, flat or
 * glass, applies live. Sizes that depend on room ask the VIEW (every view is a container), not the window. */
export const PANEL_CSS = [BASE_CSS, SURFACE_CSS, HEARD_HERO_CSS, css`
  :host { display: block; }

  /* ---- views ---- */
  [data-view] { display: block; container-type: inline-size; min-width: 0; }
  h2, h3, p { margin: 0; }
  .credit { margin-top: var(--lu-space-1); overflow-wrap: anywhere; }
  h2 { font-size: var(--lu-type-title); font-weight: 620; letter-spacing: -.012em; line-height: 1.2; }
  h3 { margin-bottom: var(--lu-space-3); font-size: var(--lu-type-label); font-weight: 600; }
  p { line-height: 1.45; }
  .page { display: grid; gap: var(--lu-space-5); min-width: 0; }
  .toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--lu-space-3) var(--lu-space-4); }
  .toolbar kestrel-lu-segmented { flex: 1 1 280px; }
  .toolbar p { flex: 1 1 14rem; font-size: var(--lu-type-label); }
  .error-banner { margin-bottom: var(--lu-space-4); }
  .action-row { display: flex; flex-wrap: wrap; justify-content: center; gap: var(--lu-space-2); }

  /* The app bar's keyboard button is for people with a keyboard. */
  .shortcuts { display: none; }
  @media (hover: hover) and (pointer: fine) { .shortcuts { display: inline-flex; } }
  /* The strip that says the websocket is down sits in the shell's bottom slot, so it moves nothing when it comes and goes. */
  kestrel-lu-state[slot="bottom"] { padding: 0 var(--lu-edge-x); }

  /* ---- Live: camera tiles ---- */
  .camera-tile { display: grid; min-width: 0; overflow: hidden; border: 1px solid var(--lu-edge); border-radius: var(--lu-radius-card); color: var(--lu-ink); }
  .camera-focus { display: block; width: 100%; padding: 0; border: 0; color: inherit; background: transparent; font: inherit; text-align: left; cursor: pointer; -webkit-tap-highlight-color: transparent; }
  .camera-focus:is(:active, [data-pressed]) .camera-picture::after { content: ""; position: absolute; inset: 0; background: var(--lu-material-press-wash); pointer-events: none; }
  .camera-focus:is(:active, [data-pressed]) .camera-name { background: var(--lu-material-press-wash); }
  @media (hover: hover) and (pointer: fine) { .camera-focus:hover { background: var(--lu-material-hover-wash); } }
  .camera-name { display: block; padding: var(--lu-space-3) var(--lu-space-4) var(--lu-space-2); font-weight: 600; }
  .camera-sighting { display: flex; align-items: center; min-height: var(--lu-target); padding: 0 var(--lu-space-3) var(--lu-space-2); }
  .camera-sighting .muted { padding: 0 var(--lu-space-1); font-size: var(--lu-type-caption); }
  .camera-picture { position: relative; overflow: hidden; aspect-ratio: 16 / 9; background: var(--lu-tile); }
  .camera-picture kestrel-live-player { position: absolute; inset: 0; }
  .camera-picture .camera-snapshot { position: absolute; inset: 0; width: 100%; height: 100%; }
  .camera-health { position: absolute; top: var(--lu-space-2); left: var(--lu-space-2); }
  .snapshot-chip { position: absolute; top: var(--lu-space-2); right: var(--lu-space-2); z-index: 1; }
  .stream-placeholder { display: grid; place-items: center; min-height: 44px; padding: var(--lu-space-4); color: var(--lu-ink-3); font-size: var(--lu-type-caption); text-align: center; }
  .stream-placeholder.static { position: absolute; inset: 0; gap: var(--lu-space-2); align-content: center; }
  .stream-placeholder.static ha-icon { --mdc-icon-size: 26px; width: 26px; height: 26px; }
  .all-unsupported { margin-top: var(--lu-space-4); }

  /* ---- Live: one camera ---- */
  .focused-camera { display: grid; gap: var(--lu-space-4); }
  .focused-heading { display: flex; flex-wrap: wrap; align-items: center; gap: var(--lu-space-3) var(--lu-space-4); }
  .focused-heading h2 { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
  .focused-snapshot { position: relative; }
  .focused-snapshot .snapshot-image { display: block; width: 100%; aspect-ratio: 16 / 9; min-height: clamp(240px, 45cqi, 520px); border-radius: var(--lu-radius-card); }
  .camera-meta { display: flex; flex-wrap: wrap; align-items: center; gap: var(--lu-space-4); color: var(--lu-ink-2); font-size: var(--lu-type-label); }
  .unsupported-stream { border: 1px solid var(--lu-edge); border-radius: var(--lu-radius-card); background: var(--lu-tile); }

  /* ---- Wildlife ---- */
  .species-tile { display: grid; align-content: start; min-width: 0; gap: var(--lu-space-2); padding: 0 0 var(--lu-space-3); border: 0; border-radius: var(--lu-radius-card); color: var(--lu-ink); background: transparent; font: inherit; text-align: left; cursor: pointer; -webkit-tap-highlight-color: transparent; transition: background-color var(--lu-motion-label) var(--lu-ease); }
  .species-tile:is(:active, [data-pressed]) { background: var(--lu-material-press-wash); transition: none; }
  .species-tile:is(:active, [data-pressed]) .species-photo::after { content: ""; position: absolute; inset: 0; border-radius: var(--lu-radius-tile); background: var(--lu-material-press-wash); pointer-events: none; }
  @media (hover: hover) and (pointer: fine) { .species-tile:hover { background: var(--lu-material-hover-wash); } }
  .species-photo { position: relative; }
  .badge-row { position: absolute; left: var(--lu-space-2); bottom: var(--lu-space-2); display: flex; gap: var(--lu-space-1); pointer-events: none; }
  .species-name { padding: var(--lu-space-1) var(--lu-space-2) 0; overflow-wrap: anywhere; font-size: var(--lu-type-label); font-weight: 600; }
  .species-last { display: flex; align-items: flex-start; gap: var(--lu-space-1); padding: 0 var(--lu-space-2); color: var(--lu-ink-2); font-size: var(--lu-type-caption); line-height: 1.35; }
  .species-last ha-icon { --mdc-icon-size: 14px; width: 14px; height: 14px; flex: none; margin-top: 1px; }
  .species-new { padding: 0 var(--lu-space-2); }
  .show-more { display: flex; justify-content: center; margin-top: var(--lu-space-2); }

  /* ---- the visit page: the picture left, the facts and the one main action right when there is room ---- */
  .visit-view { display: grid; gap: var(--lu-space-4); max-width: 1440px; margin: 0 auto; }
  @container (min-width: 900px) { .visit-view { grid-template-columns: minmax(0, 1.45fr) minmax(280px, .8fr); align-items: start; gap: var(--lu-space-5); } }
  @media (max-height: 500px) { @container (min-width: 640px) { .visit-view { grid-template-columns: minmax(0, 1.1fr) minmax(260px, .9fr); align-items: start; gap: var(--lu-space-5); } } }
  .visit-hero { position: relative; min-width: 0; overflow: hidden; padding: var(--lu-space-2); }
  .visit-hero .hero-media { position: relative; }
  .visit-hero kestrel-lu-image { --lu-image-radius: var(--lu-radius-tile); }
  .visit-video { display: block; width: 100%; max-height: 68vh; aspect-ratio: 16 / 10; border-radius: var(--lu-radius-tile); background: var(--lu-tile); object-fit: contain; }
  .clip-progress { display: grid; gap: var(--lu-space-2); padding: var(--lu-space-4) var(--lu-space-2) var(--lu-space-2); }
  .progress-label { display: flex; justify-content: space-between; gap: var(--lu-space-3); color: var(--lu-ink-2); font-size: var(--lu-type-label); }
  .progress-track, .meter { height: 6px; overflow: hidden; border-radius: var(--lu-radius-pill); background: var(--lu-track-off); }
  .progress-track span, .meter span { display: block; height: 100%; border-radius: inherit; background: var(--lu-accent); transition: width var(--lu-motion-label) var(--lu-ease); }
  .media-note { padding: var(--lu-space-3); color: var(--lu-ink-2); font-size: var(--lu-type-label); }
  .visit-summary { display: grid; gap: var(--lu-space-4); min-width: 0; }
  .visit-title-row { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--lu-space-4); }
  .visit-title-row h2 { max-width: 18ch; overflow-wrap: anywhere; }
  .visit-title-row p { margin-top: var(--lu-space-2); font-size: var(--lu-type-label); }
  .score { color: var(--lu-ink); font-size: var(--lu-type-display); font-weight: 350; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .score small { color: var(--lu-ink-3); font-size: var(--lu-type-label); }
  .visit-tags { display: flex; flex-wrap: wrap; gap: var(--lu-space-2); }
  .visit-actions { display: flex; flex-wrap: wrap; gap: var(--lu-space-2); margin-top: var(--lu-space-1); }
  .heard-panel { display: grid; grid-template-columns: 1fr minmax(0, 210px); align-items: center; gap: var(--lu-space-3); padding: var(--lu-space-4); }
  .heard-copy { display: flex; flex-direction: column; gap: var(--lu-space-1); }
  .heard-copy strong { font-size: var(--lu-type-label); }
  .heard-copy span { font-size: var(--lu-type-caption); }
  .heard-panel > kestrel-lu-button { grid-column: 1 / -1; justify-self: start; }
  @container (max-width: 400px) { .heard-panel { grid-template-columns: 1fr; } }

  /* ---- the sheets: the correction picker and the shortcut list ---- */
  .species-search { width: 100%; min-height: var(--lu-target); margin: 0 0 var(--lu-space-2); padding: 0 var(--lu-space-4); border: 1px solid var(--lu-edge-raised); border-radius: var(--lu-radius-control); color: var(--lu-ink); background: var(--lu-tile); font: 400 var(--lu-type-body) var(--lu-font); }
  .species-search::placeholder { color: var(--lu-ink-3); }
  .special-choices { display: flex; flex-wrap: wrap; gap: var(--lu-space-2); }
  kbd { display: inline-grid; min-width: calc(var(--lu-type-caption) * 2); place-items: center; padding: 0 var(--lu-space-2); border: 1px solid var(--lu-edge-raised); border-radius: var(--lu-radius-control); background: var(--lu-glass-raised); box-shadow: var(--lu-highlight-raised); font: 600 var(--lu-type-caption)/1.9 var(--lu-font); }

  /* ---- AI check-up ---- */
  .insights-view { display: grid; gap: var(--lu-space-5); max-width: 1440px; margin: 0 auto; }
  .review-section, .noisy-section { padding: var(--lu-space-5); }
  .card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--lu-space-3); margin-bottom: var(--lu-space-3); }
  .card-head h3 { margin-bottom: var(--lu-space-1); font-size: var(--lu-type-body); font-weight: 620; }
  .card-head p { font-size: var(--lu-type-label); }
  .review-thumb { width: 56px; --lu-image-radius: var(--lu-radius-control); }
  .review-why { margin: calc(-1 * var(--lu-space-2)) 0 var(--lu-space-2); padding-inline: calc(var(--lu-space-3) * 2 + 56px) var(--lu-space-3); color: var(--lu-ink-2); font-size: var(--lu-type-label); line-height: 1.35; }
  .simple-list { display: grid; margin: 0; padding: 0; list-style: none; }
  .simple-list li { display: flex; min-height: var(--lu-target); align-items: center; justify-content: space-between; gap: var(--lu-space-3); border-bottom: 1px solid var(--lu-edge); color: var(--lu-ink-2); font-size: var(--lu-type-label); }
  .simple-list li:last-child { border-bottom: 0; }
  .simple-list strong { color: var(--lu-ink); font-variant-numeric: tabular-nums; }
  .empty-inline { padding: var(--lu-space-3) 0; color: var(--lu-ink-2); font-size: var(--lu-type-label); }
  .health-tile { display: flex; min-width: 0; flex-direction: column; gap: var(--lu-space-2); padding: var(--lu-space-4); }
  .health-title { display: flex; align-items: center; gap: var(--lu-space-2); color: var(--lu-ink-2); font-size: var(--lu-type-caption); }
  .health-title ha-icon { --mdc-icon-size: 18px; width: 18px; height: 18px; color: var(--lu-accent); }
  .health-tile strong { overflow-wrap: anywhere; font-size: var(--lu-type-title); font-weight: 600; font-variant-numeric: tabular-nums; }
  .health-tile p, .health-tile small { color: var(--lu-ink-2); font-size: var(--lu-type-caption); line-height: 1.4; }
  .health-tile small { margin-top: auto; }
  .health-tile .meter { width: 100%; margin: var(--lu-space-1) 0; }
  .health-tile .healthy { color: var(--lu-positive); }
  .health-tile .unhealthy { color: var(--lu-warning); }

  /* A short screen (a phone held sideways, a wall display) gives the picture the whole height and puts the name, status and sightings beside it. */
  @media (max-height: 500px) {
    .focused-camera { grid-template-columns: minmax(0, 1fr) minmax(11rem, 16rem); grid-template-rows: auto 1fr; align-items: start; column-gap: var(--lu-space-4); }
    .focused-camera > .focused-heading { grid-column: 2; grid-row: 1; flex-direction: column; align-items: flex-start; gap: var(--lu-space-2); }
    .focused-camera > kestrel-live-player, .focused-camera > .focused-snapshot, .focused-camera > .unsupported-stream { grid-column: 1; grid-row: 1 / span 2; max-height: calc(100dvh - var(--lu-top-chrome, 48px) - var(--lu-edge-y) * 2); }
    .camera-meta { grid-column: 2; grid-row: 2; flex-direction: column; align-items: flex-start; }
    .focused-snapshot .snapshot-image { min-height: 0; max-height: calc(100dvh - var(--lu-top-chrome, 48px) - var(--lu-edge-y) * 2); }
  }
  @media (prefers-reduced-motion: reduce) {
    .progress-track span, .meter span { transition: none; }
  }
`];
