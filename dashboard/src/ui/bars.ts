import { css, html, type TemplateResult } from "lit";
import { clamp } from "../format.ts";

/** The look of a bar chart: one slim bar per slot, as tall as its value is next to the biggest, with a row of labels under it. The sheet's
 * "When it visits" (24 hours) and "Last 30 days" are both drawn with it. Add it to the element's `static styles`. */
export const BARS_CSS = css`
  .bars { display: grid; height: 100px; grid-template-columns: repeat(var(--bars), minmax(0, 1fr)); align-items: end; gap: 3px; padding: var(--lu-space-2) 0; }
  .bar { height: var(--bar-height); min-height: 4px; border-radius: 4px 4px 1px 1px; background: var(--lu-accent); opacity: .78; }
  .bar-labels { display: flex; justify-content: space-between; color: var(--lu-ink-3); font-size: var(--lu-type-caption); }
`;

export interface Bar { value: number; title: string }

/** The chart as one picture for a screen reader (`description`), with each bar's own `title` for a pointer. A slot with nothing in it is still a sliver, so the gap
 * is a visible part of the picture. */
export function barChart(bars: readonly Bar[], labels: readonly string[], description: string): TemplateResult {
  const max = Math.max(1, ...bars.map((bar) => bar.value));
  return html`<div class="bars" style=${`--bars:${bars.length}`} role="img" aria-label=${description}>${bars.map((bar) => html`<span class="bar" style=${`--bar-height:${clamp((bar.value / max) * 100, 4, 100)}%`} title=${bar.title}></span>`)}</div>
    <div class="bar-labels">${labels.map((label) => html`<span>${label}</span>`)}</div>`;
}
