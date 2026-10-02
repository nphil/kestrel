import { css, html, nothing, type TemplateResult } from "lit";

/** Small parts shared by tiles and cards. Plain classes rather than elements, so a grid of seventy tiles
 * costs no extra shadow roots. Token-only; add to a component's `static styles`.
 *
 * - `.badge-row` > `.badge`: passive pills laid over a photo (an icon, optionally a count). Never focusable.
 * - `.chip-button`: a tappable pill with a leading icon and two quiet lines of text.
 * - `.bone`: a shaped placeholder, so loading looks like the content that is coming. */
export const PARTS_CSS = css`
  .badge-row { position: absolute; left: var(--lu-space-2); bottom: var(--lu-space-2); display: flex; gap: var(--lu-space-1); pointer-events: none; }
  .badge { display: inline-flex; align-items: center; gap: var(--lu-space-1); min-height: max(28px, calc(var(--lu-type-caption) * 2)); padding: 0 var(--lu-space-3) 0 var(--lu-space-2); border: 1px solid var(--lu-edge); border-radius: var(--lu-radius-pill); color: var(--lu-ink); background: var(--lu-reading); font-size: var(--lu-type-caption); font-weight: 600; font-variant-numeric: tabular-nums; }
  .badge.bare { padding: 0 var(--lu-space-2); }
  .badge ha-icon { --mdc-icon-size: calc(var(--lu-type-caption) * 1.35); width: calc(var(--lu-type-caption) * 1.35); height: calc(var(--lu-type-caption) * 1.35); flex: none; }
  .chip-button { display: inline-flex; align-items: center; gap: var(--lu-space-2); min-width: 0; max-width: 100%; min-height: var(--lu-target); padding: var(--lu-space-1) var(--lu-space-3) var(--lu-space-1) var(--lu-space-2); border: 1px solid var(--lu-edge); border-radius: var(--lu-radius-control); color: var(--lu-ink); background: var(--lu-tile); font: 500 var(--lu-type-label)/1.25 var(--lu-font); text-align: left; cursor: pointer; transition: background-color var(--lu-motion-label) var(--lu-ease); }
  .chip-button:is(:active, [data-pressed]) { background-color: var(--lu-glass-raised); background-image: linear-gradient(var(--lu-material-press-wash), var(--lu-material-press-wash)); transition: none; }
  @media (hover: hover) and (pointer: fine) { .chip-button:hover { background: var(--lu-glass-raised); } }
  .chip-button > ha-icon { --mdc-icon-size: 20px; width: 20px; height: 20px; flex: none; color: var(--lu-accent); }
  .chip-button .lines { display: grid; min-width: 0; }
  .chip-button .lines > * { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chip-button .lead { font-weight: 600; }
  .chip-button .sub { color: var(--lu-ink-2); font-size: var(--lu-type-caption); }
  .bone { display: block; border-radius: var(--lu-radius-tile); background: var(--lu-tile); animation: bone 1.4s ease-in-out infinite; }
  @keyframes bone { 50% { opacity: .55; } }
  @media (prefers-reduced-motion: reduce) { .bone { animation: none; } }
`;

/** An evidence badge: an icon and, when there is one, a count. */
export function badge(icon: string, count?: number | string | null): TemplateResult {
  return html`<span class=${count ? "badge" : "badge bare"}><ha-icon .icon=${icon}></ha-icon>${count ? html`<span>${count}</span>` : nothing}</span>`;
}
