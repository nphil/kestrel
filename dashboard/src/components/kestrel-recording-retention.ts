import { BASE_CSS } from "lucent-ha";
import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { live } from "lit/directives/live.js";
import { api } from "../api.ts";
import { birdnetFailure } from "../format.ts";
import { DAY_OPTIONS, MODE_OPTIONS, fullPercent, guardNote, keepAbout, keptLine, modeOf, removalQuestion, spaceLine, spaceWarning, tidyNote, timeChoice } from "../retention.ts";
import type { HomeAssistant, RecordingRetention, RetentionChoice } from "../types.ts";

/** The "Bird recordings" part of the settings sheet: how full the storage BirdNET-Go saves its recordings to is, and how long they are kept (30, 60 or 90 days,
 * or until space runs low). Only an administrator can change it, and a change that could remove recordings asks first. Recordings that were kept are never removed.
 * `active` is true while the settings sheet is open; the numbers are read afresh each time. */
export class KestrelRecordingRetention extends LitElement {
  static properties = {
    hass: { attribute: false },
    active: { type: Boolean },
    _retention: { state: true },
    _loading: { state: true },
    _loadError: { state: true },
    _asking: { state: true },
    _saving: { state: true },
    _saveError: { state: true },
  };

  declare hass: HomeAssistant | undefined;
  declare active: boolean;
  declare _retention: RecordingRetention | null;
  declare _loading: boolean;
  declare _loadError: string;
  /** A choice waiting for a yes, because it could remove recordings. */
  declare _asking: RetentionChoice | null;
  /** The choice being saved, or null. */
  declare _saving: RetentionChoice | null;
  declare _saveError: string;

  private _generation = 0;

  constructor() {
    super();
    this.active = false;
    this._retention = null;
    this._loading = false;
    this._loadError = "";
    this._asking = null;
    this._saving = null;
    this._saveError = "";
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this._generation++;
  }

  protected willUpdate(changed: PropertyValues<this>): void {
    if (!changed.has("active")) return;
    if (this.active) void this._load(); else this._generation++;
  }

  protected updated(changed: PropertyValues<this>): void {
    // The safe answer has the focus, so Enter or Space never removes recordings by accident. (A Lucent button only has its inner button once it has rendered.)
    if (!changed.has("_asking") || !this._asking) return;
    const keep = this.renderRoot.querySelector<LitElement>(".keep");
    void keep?.updateComplete.then(() => keep.focus({ preventScroll: true }));
  }

  private async _load(): Promise<void> {
    const hass = this.hass;
    if (!hass) return;
    const generation = ++this._generation;
    this._loading = this._retention === null;
    this._loadError = "";
    this._asking = null;
    this._saving = null;
    this._saveError = "";
    try {
      const retention = await api.retention(hass);
      if (generation !== this._generation) return;
      this._retention = retention;
    } catch (error) {
      if (generation === this._generation) this._loadError = birdnetFailure(error);
    } finally {
      if (generation === this._generation) this._loading = false;
    }
  }

  /** Make a choice: at once, or, when it could remove recordings, after a yes. */
  private _choose(keep: RetentionChoice): void {
    const retention = this._retention;
    if (!retention?.canChange || this._saving !== null || keep === retention.keep) return;
    this._saveError = "";
    if (!removalQuestion(retention, keep)) { void this._save(keep); return; }
    this._asking = keep;
    this.requestUpdate(); // a Lucent control shows what was pressed; this puts it back to what is still saved while the question is open
  }

  private async _save(keep: RetentionChoice): Promise<void> {
    const hass = this.hass;
    if (!hass || this._saving !== null) return;
    const generation = ++this._generation;
    this._asking = null;
    this._saving = keep;
    this._saveError = "";
    try {
      const saved = await api.setRetention(hass, keep);
      if (generation !== this._generation) return;
      this._retention = saved;
    } catch (error) {
      if (generation === this._generation) this._saveError = birdnetFailure(error);
    } finally {
      if (generation === this._generation) this._saving = null;
    }
  }

  private _onMode(event: CustomEvent<{ value: string }>): void {
    event.stopPropagation();
    if (this._retention) this._choose(event.detail.value === "space" ? "space" : timeChoice(this._retention));
  }

  private _onDays(event: CustomEvent<{ value: string }>): void {
    event.stopPropagation();
    const choice = DAY_OPTIONS.find((option) => option.value === event.detail.value);
    if (choice) this._choose(choice.value);
  }

  private _renderStorage(retention: RecordingRetention) {
    const storage = retention.storage;
    const kept = keptLine(retention.kept);
    const keptText = kept ? html`<p class="kept">${kept}</p>` : nothing;
    if (storage === null) return html`<p class="unknown">Kestrel can't tell how much storage the recordings use right now.</p>${keptText}`;
    const line = spaceLine(storage);
    const percent = fullPercent(storage);
    return html`
      <p class="summary" role="status"><strong>${line.used}</strong> <span>${line.rest}</span></p>
      <div class="meter" role="meter" aria-label="Recording storage used" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${percent}><span class=${percent >= retention.guardPercent ? "near" : ""} style=${`width:${percent}%`}></span></div>
      ${keptText}`;
  }

  private _renderConfirm(retention: RecordingRetention, keep: RetentionChoice) {
    const ask = removalQuestion(retention, keep);
    if (!ask) return nothing;
    return html`<div class="confirm" role="group" aria-label="Confirm removing recordings">
      <p class="ask">${ask.question}</p>
      <p class="about">${ask.about}</p>
      <div class="buttons">
        <kestrel-lu-button kind="danger" icon="mdi:delete-outline" label=${ask.button} @click=${() => this._save(keep)}></kestrel-lu-button>
        <kestrel-lu-button class="keep" kind="secondary" label="Keep recordings" @click=${() => { this._asking = null; }}></kestrel-lu-button>
      </div>
    </div>`;
  }

  private _renderKeep(retention: RecordingRetention) {
    const saving = this._saving !== null;
    const shown = this._saving ?? retention.keep;
    const mode = modeOf(shown);
    const about = keepAbout(retention, shown);
    const warning = spaceWarning(retention, shown);
    const tidy = tidyNote(retention);
    const locked = saving || !retention.canChange;
    return html`
      <p class="label">Keep recordings</p>
      <kestrel-lu-segmented label="Keep recordings" .options=${MODE_OPTIONS} .value=${live(mode)} ?disabled=${locked} @lu-change=${this._onMode}></kestrel-lu-segmented>
      ${mode === "time" ? html`
        <p class="label">For how long</p>
        <kestrel-lu-segmented label="For how long" .options=${DAY_OPTIONS} .value=${live(shown)} ?disabled=${locked} @lu-change=${this._onDays}></kestrel-lu-segmented>` : nothing}
      <p class="about"><strong>${about.lead}</strong> ${about.text}</p>
      ${mode === "time" && !warning ? html`<p class="about">${guardNote(retention)}</p>` : nothing}
      ${warning ? html`<p class="warning" role="status"><ha-icon .icon=${"mdi:alert-outline"}></ha-icon><span>${warning}</span></p>` : nothing}
      ${saving ? html`<p class="note" role="status"><kestrel-lu-chip kind="info" label="Saving…"></kestrel-lu-chip></p>` : nothing}
      ${this._saveError ? html`<p class="problem" role="alert"><ha-icon .icon=${"mdi:alert-circle-outline"}></ha-icon><span>${this._saveError} Nothing was changed.</span></p>` : nothing}
      ${this._asking ? this._renderConfirm(retention, this._asking) : nothing}
      ${retention.canChange ? nothing : html`<p class="note">Only a Home Assistant administrator can change this.</p>`}
      ${tidy ? html`<p class="note">${tidy}</p>` : nothing}`;
  }

  static styles = [BASE_CSS, css`
    :host { display: block; }
    p { margin: 0; }
    .summary { display: flex; align-items: baseline; flex-wrap: wrap; gap: var(--lu-space-2) var(--lu-space-3); margin-bottom: var(--lu-space-3); }
    .summary strong { font-size: var(--lu-type-display); font-weight: 350; font-variant-numeric: tabular-nums; line-height: 1; }
    .summary span, .unknown, .kept { color: var(--lu-ink-2); font-size: var(--lu-type-label); }
    .meter { height: 6px; overflow: hidden; border-radius: var(--lu-radius-pill); background: var(--lu-track-off); }
    .meter span { display: block; height: 100%; border-radius: inherit; background: var(--lu-accent); transition: width var(--lu-motion-label) var(--lu-ease); }
    .meter .near { background: var(--lu-warning); }
    .kept { margin-top: var(--lu-space-3); }
    .label { margin: var(--lu-space-5) 0 var(--lu-space-2); font-size: var(--lu-type-label); font-weight: 600; }
    .about { margin-top: var(--lu-space-3); color: var(--lu-ink-2); font-size: var(--lu-type-label); }
    .about strong { color: var(--lu-ink); font-weight: 600; }
    .warning, .problem { display: flex; align-items: flex-start; gap: var(--lu-space-2); margin-top: var(--lu-space-3); font-size: var(--lu-type-label); }
    .warning ha-icon { color: var(--lu-warning); }
    .problem { color: var(--lu-danger); }
    .warning ha-icon, .problem ha-icon { flex: none; --mdc-icon-size: 20px; }
    .note { margin-top: var(--lu-space-3); color: var(--lu-ink-3); font-size: var(--lu-type-caption); }
    .confirm { display: grid; gap: var(--lu-space-3); margin-top: var(--lu-space-4); padding: var(--lu-space-4); border: 1px solid var(--lu-edge); border-radius: var(--lu-radius-tile); background: var(--lu-tile); }
    .ask { font-size: var(--lu-type-body); font-weight: 600; }
    .confirm .about { margin-top: 0; }
    .buttons { display: flex; flex-wrap: wrap; gap: var(--lu-space-2); }
    @media (prefers-reduced-motion: reduce) { .meter span { transition: none; } }
  `];

  render() {
    const retention = this._retention;
    if (!retention) {
      if (this._loading) return html`<kestrel-lu-state kind="loading" variant="text" count="3" heading="Asking BirdNET-Go"></kestrel-lu-state>`;
      return html`<kestrel-lu-state kind="error" compact heading="Couldn't read the recording settings" .message=${this._loadError || "Kestrel couldn't reach BirdNET-Go."} @lu-retry=${() => this._load()}></kestrel-lu-state>`;
    }
    return html`
      ${this._renderStorage(retention)}
      ${this._loadError ? html`<p class="problem" role="alert"><ha-icon .icon=${"mdi:alert-circle-outline"}></ha-icon><span>${this._loadError}</span></p>` : nothing}
      ${this._renderKeep(retention)}`;
  }
}

customElements.define("kestrel-recording-retention", KestrelRecordingRetention);

declare global { interface HTMLElementTagNameMap { "kestrel-recording-retention": KestrelRecordingRetention; } }
