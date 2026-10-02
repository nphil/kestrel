import { css, html, type TemplateResult } from "lit";

/** The picture stand-in for something that was only heard: a waveform on the picture's own background. It fills the
 * nearest positioned box, so the same markup works in a tile, a hero and the toolkit image's `fallback` slot.
 * Add `HEARD_HERO_CSS` to the element's `static styles`. */
export const HEARD_HERO_CSS = css`
  .heard-hero { position: absolute; inset: 0; display: grid; place-items: center; color: var(--lu-ink-3); pointer-events: none; }
  .heard-hero ha-icon { --mdc-icon-size: 40px; width: 40px; height: 40px; }
`;

export function heardHero(icon: string, slot?: string): TemplateResult {
  return slot
    ? html`<div class="heard-hero" slot=${slot} aria-hidden="true"><ha-icon .icon=${icon}></ha-icon></div>`
    : html`<div class="heard-hero" aria-hidden="true"><ha-icon .icon=${icon}></ha-icon></div>`;
}
