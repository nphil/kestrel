import { BASE_CSS } from "lucent-ha";
import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { api } from "../api.ts";
import { keepCaption } from "../keep.ts";
import type { HomeAssistant, KeptRecording } from "../types.ts";

type Phase = "loading" | "ready" | "none" | "unavailable";

/** "Keep recording" on a recording of a heard call: BirdNET-Go deletes sounds after 30 days, and a kept one is skipped by that clean-up.
 * `visit-id` is the visit whose recording it is (a heard visit, or the heard visit linked to a sighting). Nothing is asked until `hass` and the
 * visit are both there. A recording BirdNET-Go has nothing to lock for (no saved sound) draws nothing at all. Only an administrator can change it;
 * everyone else sees the state, disabled. A change shows at once and is put back, with a message, when BirdNET-Go does not take it. */
export class KestrelKeepRecording extends LitElement {
  static properties = {
    // Read when asking; Home Assistant hands over a new one for every change in the house, none of which needs this drawn again.
    hass: { attribute: false, hasChanged: () => false },
    visitId: { type: String, attribute: "visit-id" },
    _phase: { state: true },
    _state: { state: true },
    _busy: { state: true },
    _failed: { state: true },
    _status: { state: true },
  };

  declare hass: HomeAssistant | undefined;
  declare visitId: string;
  declare _phase: Phase;
  declare _state: KeptRecording;
  declare _busy: boolean;
  declare _failed: boolean;
  /** What the polite live region says. */
  declare _status: string;

  /** The visit asked about. */
  private _started = "";
  /** Counts questions and answers: one that comes back for another visit, or after a newer press, is ignored. */
  private _request = 0;

  constructor() {
    super();
    this.visitId = "";
    this._phase = "loading";
    this._state = { keepable: false, kept: false, canChange: false };
    this._busy = false;
    this._failed = false;
    this._status = "";
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this._request += 1;
    this._started = ""; // asked again if it comes back
  }

  protected willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("visitId") && this.visitId !== this._started) {
      this._request += 1;
      this._started = "";
      this._phase = "loading";
      this._busy = false;
      this._failed = false;
      this._status = "";
    }
  }

  protected updated(): void {
    if (this.hass && this.visitId && this._started !== this.visitId) {
      this._started = this.visitId;
      void this._load();
    }
  }

  private async _load(): Promise<void> {
    const hass = this.hass;
    const visitId = this.visitId;
    if (!hass || !visitId) return;
    const request = ++this._request;
    this._phase = "loading";
    try {
      const state = await api.recordingKept(hass, visitId);
      if (request !== this._request) return;
      this._state = state;
      this._phase = state.keepable ? "ready" : "none";
    } catch {
      if (request !== this._request) return;
      this._phase = "unavailable";
    }
  }

  private _retry = (): void => { void this._load(); };

  private _toggle = (): void => { void this._change(); };

  private async _change(): Promise<void> {
    const hass = this.hass;
    const visitId = this.visitId;
    if (!hass || !visitId || this._busy || !this._state.canChange) return;
    const before = this._state;
    const keep = !before.kept;
    const request = ++this._request;
    this._state = { ...before, kept: keep };
    this._busy = true;
    this._failed = false;
    try {
      const state = await api.keepRecording(hass, visitId, keep);
      if (request !== this._request) return;
      this._state = state;
      this._phase = state.keepable ? "ready" : "none";
      this._status = state.kept ? "Recording kept." : "Recording is no longer kept.";
    } catch {
      if (request !== this._request) return;
      this._state = before;
      this._failed = true;
      this._status = "Couldn't change this recording.";
    } finally {
      if (request === this._request) this._busy = false;
    }
  }

  static styles = [BASE_CSS, css`
    :host { display: block; grid-column: 1 / -1; min-width: 0; padding-top: var(--lu-space-3); border-top: 1px solid var(--lu-edge); }
    .row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--lu-space-1) var(--lu-space-3); min-width: 0; }
    .caption { margin: 0; color: var(--lu-ink-2); font-size: var(--lu-type-caption); line-height: 1.4; overflow-wrap: anywhere; }
    .caption.failed { color: var(--lu-danger); }
  `];

  render() {
    if (!this.visitId || this._phase === "none") return nothing;
    if (this._phase === "loading") return html`<div class="row" aria-busy="true"><kestrel-lu-chip interactive disabled icon="mdi:pin-outline" label="Keep recording"></kestrel-lu-chip></div>`;
    if (this._phase === "unavailable") {
      return html`<div class="row"><p class="caption">Couldn't check whether this recording is kept.</p><kestrel-lu-button kind="quiet" label="Try again" @click=${this._retry}></kestrel-lu-button></div>`;
    }
    const state = this._state;
    return html`<div class="row" role="group" aria-label="Keep this recording">
        <kestrel-lu-chip interactive ?selected=${state.kept} icon=${state.kept ? "mdi:pin" : "mdi:pin-outline"} label="Keep recording" ?disabled=${!state.canChange || this._busy} @click=${this._toggle}></kestrel-lu-chip>
        <p class=${this._failed ? "caption failed" : "caption"}>${keepCaption(state, this._failed)}</p>
      </div>
      <p class="sr-only" role="status" aria-live="polite">${this._status}</p>`;
  }
}

customElements.define("kestrel-keep-recording", KestrelKeepRecording);

declare global { interface HTMLElementTagNameMap { "kestrel-keep-recording": KestrelKeepRecording; } }
