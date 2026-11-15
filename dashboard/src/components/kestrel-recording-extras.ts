import { BASE_CSS } from "lucent-ha";
import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { api } from "../api.ts";
import { knownExtras, loadExtras } from "../recordings.ts";
import type { HomeAssistant } from "../types.ts";
import { WEATHER_CSS, weatherLine } from "../ui/weather.ts";
import "./kestrel-spectrogram.ts";

/** What goes under a single recording on a visit's page: the weather at the time and the spectrogram, the same as under each recording in a list.
 * `visit-id` is the visit whose recording it is (the server finds the recording); `follows` is the recording's own addresses, so the line on the
 * spectrogram moves with the player above it. Nothing shows (and no space is kept) once it is known there is nothing to show. */
export class KestrelRecordingExtras extends LitElement {
  static properties = {
    visitId: { type: String, attribute: "visit-id" },
    follows: { attribute: false },
    label: { type: String },
    _answered: { state: true },
  };

  declare visitId: string;
  declare follows: readonly string[];
  declare label: string;
  declare _answered: string;

  /** Not reactive: the element does not redraw when Home Assistant's state changes. */
  hass: HomeAssistant | undefined;

  constructor() {
    super();
    this.visitId = "";
    this.follows = [];
    this.label = "this recording";
    this._answered = "";
  }

  protected updated(changed: PropertyValues<this>): void {
    if (changed.has("visitId")) void this._ask();
  }

  private async _ask(): Promise<void> {
    const id = this.visitId;
    const hass = this.hass;
    if (!id || !hass) return;
    await loadExtras((ids) => api.recordings(hass, ids), [id]);
    if (this.visitId === id) this._answered = id;
  }

  /** What there is to show: the answer, or just the room for it while it is on its way. */
  private _state() {
    const extras = this.visitId ? knownExtras(this.visitId) : undefined;
    const waiting = Boolean(this.visitId) && !extras && this._answered !== this.visitId;
    return { extras, waiting, show: waiting || Boolean(extras?.weather || extras?.spectrogram) };
  }

  /** The element takes no room (not even the gap a grid puts around an empty item) while there is nothing for it to show. */
  protected willUpdate(): void {
    this.hidden = !this._state().show;
  }

  static styles = [BASE_CSS, WEATHER_CSS, css`
    :host { display: block; grid-column: 1 / -1; min-width: 0; padding-top: var(--lu-space-3); border-top: 1px solid var(--lu-edge); }
    :host([hidden]) { display: none; }
    .extras { display: grid; gap: var(--lu-space-2); }
  `];

  protected render() {
    const { extras, waiting, show } = this._state();
    if (!show) return nothing;
    return html`<div class="extras">
      ${extras?.weather ? weatherLine(extras.weather) : nothing}
      <kestrel-spectrogram .src=${extras?.spectrogram ?? ""} ?pending=${waiting} .follows=${this.follows} .label=${this.label}></kestrel-spectrogram>
    </div>`;
  }
}

customElements.define("kestrel-recording-extras", KestrelRecordingExtras);

declare global { interface HTMLElementTagNameMap { "kestrel-recording-extras": KestrelRecordingExtras; } }
