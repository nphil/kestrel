import { css } from "lit";

/** Lucent v1 HA adapter: HA supplies colours; this layer supplies structure. */
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
    --lu-edge: var(--ha-card-border-color, var(--divider-color));
    --lu-tile: color-mix(in srgb, var(--primary-text-color) 6%, transparent);
    --lu-glass-raised: color-mix(in srgb, var(--primary-text-color) 12%, transparent);
    --lu-edge-raised: color-mix(in srgb, var(--primary-text-color) 22%, transparent);
    --lu-track-off: color-mix(in srgb, var(--primary-text-color) 16%, transparent);
    --lu-accent-soft: color-mix(in srgb, var(--primary-color) 18%, transparent);
    --lu-radius-card: var(--ha-card-border-radius, 24px);
    --lu-radius-sheet: max(var(--lu-radius-card), 28px);
    --lu-radius-tile: max(calc(var(--lu-radius-card) - 4px), 8px);
    --lu-radius-row: max(calc(var(--lu-radius-card) - 6px), 8px);
    --lu-radius-control: max(calc(var(--lu-radius-card) - 10px), 6px);
    --lu-radius-pill: 999px;
    --lu-target: 48px;
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
    --lu-type-display: 2.5rem;
    --lu-type-title: 1.125rem;
    --lu-type-body: 0.9375rem;
    --lu-type-label: 0.875rem;
    --lu-type-caption: 0.75rem;
    --lu-type-numeral: 1.25rem;
    --lu-ease: cubic-bezier(.33, 1, .68, 1);
    --lu-motion-press: 90ms;
    --lu-motion-label: 120ms;
    --lu-motion-focus: 150ms;
    --lu-motion-card: 180ms;
    --lu-motion-layer: 220ms;
    --lu-font: var(--ha-font-family-body, var(--paper-font-body1_-_font-family, inherit));
  }
  @media (prefers-reduced-motion: reduce) {
    :host { --lu-motion-focus: 0ms; --lu-motion-card: 0ms; --lu-motion-layer: 120ms; }
  }
`;

export const COMMON_CSS = css`
  :host { display: block; min-width: 320px; color: var(--lu-ink); font-family: var(--lu-font); }
  *, *::before, *::after { box-sizing: border-box; }
  button, input, select { font: inherit; }
  button { color: inherit; }
  a { color: var(--lu-accent); }
  button:focus-visible, a:focus-visible, input:focus-visible { outline: 2px solid var(--lu-accent); outline-offset: 2px; }
  .sheet { background: var(--lu-card); border: 1px solid var(--lu-edge); border-radius: var(--lu-radius-card); box-shadow: var(--lu-highlight-rest), var(--lu-shadow-rest); }
  .tile { background: var(--lu-tile); border: 1px solid var(--lu-edge); border-radius: var(--lu-radius-tile); }
  .raised { background: var(--lu-glass-raised); border-color: var(--lu-edge-raised); box-shadow: var(--lu-highlight-raised), var(--lu-shadow-raised); }
  .pill { display: inline-flex; align-items: center; justify-content: center; gap: var(--lu-space-2); min-height: var(--lu-target); padding: 0 var(--lu-space-5); border: 1px solid transparent; border-radius: var(--lu-radius-pill); cursor: pointer; font-size: var(--lu-type-label); font-weight: 600; text-decoration: none; transition: transform var(--lu-motion-press) var(--lu-ease), background-color var(--lu-motion-label) var(--lu-ease); }
  .pill:active:not(:disabled) { transform: scale(.97); }
  .pill.primary { color: var(--lu-accent-ink); background: var(--lu-accent); }
  .pill.secondary { color: var(--lu-ink); background: var(--lu-glass-raised); border-color: var(--lu-edge-raised); box-shadow: var(--lu-highlight-rest); }
  .pill.danger { color: var(--lu-danger); background: var(--lu-glass-raised); border-color: color-mix(in srgb, var(--lu-danger) 36%, var(--lu-edge)); }
  .pill:disabled { color: var(--lu-ink-3); background: var(--lu-tile); border-color: var(--lu-edge); cursor: not-allowed; }
  .muted { color: var(--lu-ink-2); }
  .caption { color: var(--lu-ink-3); font-size: var(--lu-type-caption); }
  .status-dot { width: 8px; height: 8px; flex: none; border-radius: 50%; background: var(--lu-ink-3); }
  .status-dot.ok { background: var(--lu-positive); }
  .status-dot.warn { background: var(--lu-warning); }
  .status-dot.danger { background: var(--lu-danger); }
  @media (prefers-reduced-motion: reduce) { .pill { transition: none; } }
`;
