import { css } from "lit";

/** Lucent v2 HA adapter: HA supplies colours; this layer supplies structure. Names mirror ha.css. The base
 * is the "ha" profile; the panel's PanelProfile controller sets `data-lu-profile` on the host and the
 * overrides below swap type, target, row and margin sizes to the phone, tablet, desktop or smart-display
 * values from LANGUAGE.md section 7. Only the panel's root element includes this; every component inside
 * inherits the tokens. Added effect permissions stay off (T0). */
export const TOKENS_CSS = css`
  :host {
    --lu-accent: var(--primary-color);
    --lu-accent-ink: var(--text-primary-color, var(--primary-background-color));
    --lu-ink: var(--primary-text-color);
    --lu-ink-2: var(--secondary-text-color);
    --lu-ink-3: var(--disabled-text-color, var(--secondary-text-color));
    --lu-positive: var(--success-color, var(--state-active-color, var(--primary-color)));
    --lu-warning: var(--warning-color, var(--primary-color));
    --lu-danger: var(--error-color, var(--primary-color));
    --lu-info: var(--info-color, var(--primary-color));
    --lu-live: var(--error-color, var(--primary-color));
    --lu-card: var(--ha-card-background, var(--card-background-color));
    /* What Home Assistant's own dialogs are made of: a surface that is readable even when the theme's cards are glass. */
    --lu-sheet: var(--ha-dialog-surface-background, var(--mdc-theme-surface, var(--card-background-color)));
    --lu-edge: var(--ha-card-border-color, var(--divider-color));
    --lu-tile: color-mix(in srgb, var(--primary-text-color) 6%, transparent);
    --lu-glass-raised: color-mix(in srgb, var(--primary-text-color) 12%, transparent);
    --lu-edge-raised: color-mix(in srgb, var(--primary-text-color) 22%, transparent);
    --lu-track-off: color-mix(in srgb, var(--primary-text-color) 16%, transparent);
    --lu-accent-soft: color-mix(in srgb, var(--primary-color) 18%, transparent);
    --lu-focus-wash: color-mix(in srgb, var(--primary-text-color) 7%, transparent);
    --lu-material-well: color-mix(in srgb, var(--primary-background-color) 30%, transparent);
    --lu-material-hover-wash: color-mix(in srgb, var(--primary-text-color) 4%, transparent);
    --lu-material-selected-wash: var(--lu-material-hover-wash);
    --lu-material-disabled-opacity: .55;
    /* A near-opaque reading surface for text that sits on photos and video (uncontrolled backgrounds). */
    --lu-reading: color-mix(in srgb, var(--primary-background-color) 88%, transparent);
    --lu-radius-card: var(--ha-card-border-radius, 24px);
    --lu-radius-sheet: max(var(--lu-radius-card), 28px);
    --lu-radius-tile: max(calc(var(--lu-radius-card) - 4px), 8px);
    --lu-radius-row: max(calc(var(--lu-radius-card) - 6px), 8px);
    --lu-radius-control: max(calc(var(--lu-radius-card) - 10px), 6px);
    --lu-radius-pill: 999px;
    --lu-target: 48px;
    --lu-row: 56px;
    --lu-space-1: 4px;
    --lu-space-2: 8px;
    --lu-space-3: 12px;
    --lu-space-4: 16px;
    --lu-space-5: 20px;
    --lu-space-6: 24px;
    --lu-space-7: 32px;
    --lu-space-8: 40px;
    --lu-highlight-rest: inset 0 1px 0 color-mix(in srgb, var(--primary-text-color) 7%, transparent);
    --lu-highlight-raised: inset 0 1px 0 color-mix(in srgb, var(--primary-text-color) 18%, transparent);
    --lu-shadow-rest: var(--ha-card-box-shadow, 0 24px 60px color-mix(in srgb, var(--primary-text-color) 14%, transparent));
    --lu-shadow-raised: 0 10px 24px color-mix(in srgb, var(--primary-text-color) 22%, transparent);
    --lu-shadow-pressed: 0 4px 10px color-mix(in srgb, var(--primary-text-color) 18%, transparent);
    /* Focus lands as light on the existing material: a lit edge, a faint wash and a 2px landing bar in ink. */
    --lu-focus-indicator: 2px;
    --lu-focus-ring: var(--lu-highlight-raised), inset 0 0 0 999px var(--lu-focus-wash), inset 0 calc(var(--lu-focus-indicator) * -1) 0 var(--lu-ink);
    --lu-type-display: 56px;
    --lu-type-title: 24px;
    --lu-type-body: 16px;
    --lu-type-label: 14px;
    --lu-type-caption: 12px;
    --lu-type-numeral: 20px;
    --lu-edge-x: 16px;
    --lu-edge-y: 16px;
    --lu-gutter: 16px;
    --lu-scrim: color-mix(in srgb, var(--primary-background-color) 70%, transparent);
    --lu-travel-layer: 16px;
    --lu-material-press-wash: color-mix(in srgb, var(--primary-text-color) 10%, transparent);
    --lu-ease: cubic-bezier(.33, 1, .68, 1);
    --lu-ease-press: cubic-bezier(.2, 0, 0, 1);
    --lu-ease-exit: cubic-bezier(.4, 0, 1, 1);
    --lu-motion-press: 90ms;
    --lu-motion-label: 120ms;
    --lu-motion-focus: 150ms;
    --lu-motion-card: 180ms;
    --lu-motion-layer: 220ms;
    --lu-motion-scroll: 300ms;
    --lu-motion-exit: 180ms;
    --lu-font: var(--ha-font-family-body, var(--paper-font-body1_-_font-family, inherit));
  }
  :host([data-lu-profile="phone"]) { --lu-row: 56px; --lu-type-display: 48px; --lu-type-title: 24px; --lu-type-body: 16px; --lu-type-label: 14px; --lu-type-caption: 12px; --lu-edge-x: 16px; --lu-edge-y: 16px; --lu-gutter: 12px; }
  :host([data-lu-profile="tablet"]) { --lu-row: 56px; --lu-type-display: 56px; --lu-type-title: 28px; --lu-type-body: 16px; --lu-type-label: 16px; --lu-type-caption: 13px; --lu-edge-x: 24px; --lu-edge-y: 24px; --lu-gutter: 24px; }
  :host([data-lu-profile="desktop"]) { --lu-row: 52px; --lu-type-display: 56px; --lu-type-title: 28px; --lu-type-body: 16px; --lu-type-label: 14px; --lu-type-caption: 12px; --lu-edge-x: 32px; --lu-edge-y: 24px; --lu-gutter: 24px; }
  :host([data-lu-profile="smart"]) { --lu-target: 64px; --lu-row: 64px; --lu-type-display: 72px; --lu-type-title: 28px; --lu-type-body: 20px; --lu-type-label: 18px; --lu-type-caption: 16px; --lu-edge-x: 24px; --lu-edge-y: 20px; --lu-gutter: 16px; --lu-sheet-max: 94dvh; }
  :host([data-lu-short]) { --lu-sheet-max: 94dvh; }
  @media (prefers-reduced-motion: reduce) {
    :host { --lu-motion-press: 0ms; --lu-motion-focus: 0ms; --lu-motion-card: 0ms; --lu-motion-layer: 120ms; --lu-motion-exit: 120ms; --lu-motion-scroll: 0ms; }
  }
`;

/** Focus, shared by every interactive element in the panel. Normal focus is not an outline; forced-colours
 * mode keeps the system one. !important so it also lands on controls that carry their own rest shadow. */
export const FOCUS_CSS = css`
  button:focus-visible, a:focus-visible, input:focus-visible, [role="radio"]:focus-visible { outline: none; box-shadow: var(--lu-focus-ring) !important; }
  @media (forced-colors: active) {
    button:focus-visible, a:focus-visible, input:focus-visible, [role="radio"]:focus-visible { outline: 2px solid CanvasText; }
  }
`;

/** Reset, focus and text helpers every component inside the panel shares. */
export const BASE_CSS = css`
  *, *::before, *::after { box-sizing: border-box; }
  button, input, select { font: inherit; }
  button { color: inherit; }
  a { color: var(--lu-accent); }
  ${FOCUS_CSS}
  .muted { color: var(--lu-ink-2); }
  .caption { color: var(--lu-ink-3); font-size: var(--lu-type-caption); }
`;

/** Buttons: pills, icon buttons and text buttons. */
export const CONTROLS_CSS = css`
  .pill { display: inline-flex; align-items: center; justify-content: center; gap: var(--lu-space-2); min-height: var(--lu-target); padding: 0 var(--lu-space-5); border: 1px solid transparent; border-radius: var(--lu-radius-pill); cursor: pointer; font-size: var(--lu-type-label); font-weight: 600; text-decoration: none; transition: background-color var(--lu-motion-label) var(--lu-ease); }
  /* Pressed feedback is a wash (a veil over pictures), never a scale: changing a transform promotes the element to its own
   * layer on every press, which measured 6-13 ms of main-thread work per press, too much for a 50 ms budget on a slower phone. */
  .pill:is(:active, [data-pressed]):not(:disabled), .icon-button:is(:active, [data-pressed]), .back-button:is(:active, [data-pressed]), .text-button:is(:active, [data-pressed]), .back-inline:is(:active, [data-pressed]) { background-image: linear-gradient(var(--lu-material-press-wash), var(--lu-material-press-wash)); }
  .pill.primary { color: var(--lu-accent-ink); background: var(--lu-accent); }
  .pill.secondary { color: var(--lu-ink); background: var(--lu-glass-raised); border-color: var(--lu-edge-raised); box-shadow: var(--lu-highlight-rest); }
  .pill.danger { color: var(--lu-danger); background: var(--lu-glass-raised); border-color: color-mix(in srgb, var(--lu-danger) 36%, var(--lu-edge)); }
  .pill:disabled { color: var(--lu-ink-3); background: var(--lu-tile); border-color: var(--lu-edge); cursor: not-allowed; }
  .icon-button, .back-button { display: inline-grid; flex: none; width: var(--lu-target); height: var(--lu-target); place-items: center; border: 0; border-radius: 50%; color: var(--lu-ink-2); background: transparent; cursor: pointer; }
  .text-button, .back-inline { display: inline-flex; align-items: center; min-height: var(--lu-target); padding: 0 var(--lu-space-3); border: 0; border-radius: var(--lu-radius-pill); color: var(--lu-accent); background: transparent; font: 600 var(--lu-type-label) var(--lu-font); text-decoration: none; cursor: pointer; }
  @media (hover: hover) and (pointer: fine) { .icon-button:hover, .back-button:hover { color: var(--lu-ink); background: var(--lu-glass-raised); } }
  @media (prefers-reduced-motion: reduce) { .pill { transition: none; } }
`;

/** The panel root: its host box, plus everything above and the sheet/tile/dot surfaces. */
export const COMMON_CSS = css`
  :host { display: block; min-width: 320px; color: var(--lu-ink); font-family: var(--lu-font); }
  ${BASE_CSS}
  ${CONTROLS_CSS}
  .sheet { background: var(--lu-card); border: 1px solid var(--lu-edge); border-radius: var(--lu-radius-card); box-shadow: var(--lu-highlight-rest), var(--lu-shadow-rest); }
  .tile { background: var(--lu-tile); border: 1px solid var(--lu-edge); border-radius: var(--lu-radius-tile); }
  .raised { background: var(--lu-glass-raised); border-color: var(--lu-edge-raised); box-shadow: var(--lu-highlight-raised), var(--lu-shadow-raised); }
  .status-dot { width: 8px; height: 8px; flex: none; border-radius: 50%; background: var(--lu-ink-3); }
  .status-dot.ok { background: var(--lu-positive); }
  .status-dot.warn { background: var(--lu-warning); }
  .status-dot.danger { background: var(--lu-danger); }
`;
