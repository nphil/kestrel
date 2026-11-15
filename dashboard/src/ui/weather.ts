import { css, html, type TemplateResult } from "lit";
import { renderIcon } from "lucent-ha";
import { weatherText, type RecordingWeather } from "../recordings.ts";

/** The weather at the time of a recording, as one quiet line: its icon and "8°C · Clear sky". Add `WEATHER_CSS` to the element's `static styles`
 * (the host also needs the toolkit's `BASE_CSS` for `.icon`). */
export const WEATHER_CSS = css`
  .weather { display: flex; align-items: center; gap: var(--lu-space-2); min-width: 0; color: var(--lu-ink-3); font-size: var(--lu-type-caption); }
  .weather .icon { --lu-icon: 16px; }
  .weather span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`;

export function weatherLine(weather: RecordingWeather): TemplateResult {
  return html`<div class="weather">${renderIcon(weather.icon)}<span>${weatherText(weather)}</span></div>`;
}
