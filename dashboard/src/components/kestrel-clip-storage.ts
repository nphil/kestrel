import { BASE_CSS } from "lucent-ha";
import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { api } from "../api.ts";
import { AGE_CHOICES, clipCount, clipFailure, cutoff, resultLine } from "../clips.ts";
import { formatBytes, monthYear } from "../format.ts";
import type { ClipChoice, ClipStorage, HomeAssistant } from "../types.ts";
import "./kestrel-clip-confirm.ts";

/** What is about to be deleted, once it has been looked up. */
interface Pending { choice: ClipChoice; count: number; bytes: number }

/** The "Saved clips" part of the settings sheet: how many camera clips Kestrel keeps and the space they take, and (for an administrator)
 * ways to delete some of them. Photos and visits are never touched. Every delete goes through a confirm step that says how many clips go.
 * `active` is true while the settings sheet is open; it reads the numbers afresh each time. */
export class KestrelClipStorage extends LitElement {
  static properties = {
    hass: { attribute: false },
    active: { type: Boolean },
    _storage: { state: true },
    _loading: { state: true },
    _loadError: { state: true },
    _step: { state: true },
    _checking: { state: true },
    _pending: { state: true },
    _deleting: { state: true },
    _note: { state: true },
    _problem: { state: true },
    _result: { state: true },
  };

  declare hass: HomeAssistant | undefined;
  declare active: boolean;
  declare _storage: ClipStorage | null;
  declare _loading: boolean;
  declare _loadError: string;
  /** `age`: choosing how far back to keep. `confirm`: said how many clips, waiting for yes or no. */
  declare _step: "idle" | "age" | "confirm";
  /** Looking up what an age limit would delete. */
  declare _checking: boolean;
  declare _pending: Pending | null;
  declare _deleting: boolean;
  /** A plain remark on the last look ("No clips are older than 3 months."). */
  declare _note: string;
  /** Why the last delete or look-up failed. */
  declare _problem: string;
  /** What the last delete did, until the next thing the person starts. */
  declare _result: string;

  private _generation = 0;

  constructor() {
    super();
    this.active = false;
    this._storage = null;
    this._loading = false;
    this._loadError = "";
    this._step = "idle";
    this._checking = false;
    this._pending = null;
    this._deleting = false;
    this._note = "";
    this._problem = "";
    this._result = "";
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this._generation++;
  }

  protected willUpdate(changed: PropertyValues<this>): void {
    if (!changed.has("active")) return;
    if (this.active) { this._reset(); void this._load(); } else this._generation++;
  }

  private _reset(): void {
    this._step = "idle";
    this._pending = null;
    this._note = "";
    this._problem = "";
    this._result = "";
  }

  private async _load(): Promise<void> {
    const hass = this.hass;
    if (!hass) return;
    const generation = ++this._generation;
    this._loading = this._storage === null;
    this._loadError = "";
    try {
      const storage = await api.clipStorage(hass);
      if (generation !== this._generation) return;
      this._storage = storage;
    } catch (error) {
      if (generation === this._generation) this._loadError = clipFailure(error);
    } finally {
      if (generation === this._generation) this._loading = false;
    }
  }

  private _startAge(): void {
    this._reset();
    this._step = "age";
  }

  private _cancel(): void {
    if (this._deleting) return;
    this._step = "idle";
    this._pending = null;
    this._problem = "";
  }

  /** Look up what "older than" would delete, then ask. */
  private async _chooseAge(choice: (typeof AGE_CHOICES)[number]): Promise<void> {
    const hass = this.hass;
    if (!hass || this._checking) return;
    const olderThan = cutoff(choice.months);
    this._note = "";
    this._problem = "";
    this._checking = true;
    const generation = this._generation;
    try {
      const covered = await api.clipStorage(hass, olderThan);
      if (generation !== this._generation) return;
      if (covered.count === 0) { this._note = `No clips are older than ${choice.label}.`; return; }
      this._pending = { choice: { older_than: olderThan }, count: covered.count, bytes: covered.bytes };
      this._step = "confirm";
    } catch (error) {
      if (generation === this._generation) this._problem = clipFailure(error);
    } finally {
      this._checking = false; // whatever happened to the sheet meanwhile, this look-up is over
    }
  }

  private _askNotAnimal(): void {
    const totals = this._storage?.byReason.notAnimal;
    if (!totals || totals.count === 0) return;
    this._reset();
    this._pending = { choice: { reason: "notAnimal" }, count: totals.count, bytes: totals.bytes };
    this._step = "confirm";
  }

  private async _delete(): Promise<void> {
    const hass = this.hass;
    const pending = this._pending;
    if (!hass || !pending || this._deleting) return;
    const generation = this._generation;
    this._deleting = true;
    this._problem = "";
    try {
      const done = await api.deleteClips(hass, pending.choice);
      if (generation !== this._generation) return;
      // The new numbers and the result appear together; if only the recount fails, the result still says what happened.
      let storage = this._storage;
      let loadError = "";
      try { storage = await api.clipStorage(hass); } catch (error) { loadError = clipFailure(error); }
      if (generation !== this._generation) return;
      this._storage = storage;
      this._loadError = loadError;
      this._result = resultLine(done.deleted, done.freedBytes);
      this._step = "idle";
      this._pending = null;
    } catch (error) {
      if (generation === this._generation) this._problem = clipFailure(error);
    } finally {
      this._deleting = false;
    }
  }

  private _renderSummary(storage: ClipStorage) {
    if (storage.count === 0) return html`<p class="empty">No clips are saved right now.</p>`;
    const oldest = storage.oldestAt === null ? "" : ` · oldest ${monthYear(storage.oldestAt)}`;
    return html`<p class="summary" role="status"><strong>${storage.count}</strong> <span>${storage.count === 1 ? "clip" : "clips"} · ${formatBytes(storage.bytes)}${oldest}</span></p>`;
  }

  private _renderActions(storage: ClipStorage) {
    const wrong = storage.byReason.notAnimal;
    return html`
      <div class="action">
        <div class="copy"><strong>Delete clips older than…</strong><span>Keep only the recent ones.</span></div>
        <kestrel-lu-button kind="secondary" icon="mdi:calendar-clock" label="Choose…" ?disabled=${storage.count === 0 || this._checking} @click=${() => this._startAge()}></kestrel-lu-button>
      </div>
      <div class="action">
        <div class="copy"><strong>Delete clips from visits marked Not an animal / Can't tell</strong><span>${wrong.count === 0 ? "None right now." : `${clipCount(wrong.count)} · ${formatBytes(wrong.bytes)}`}</span></div>
        <kestrel-lu-button kind="secondary" icon="mdi:delete-outline" label="Delete…" ?disabled=${wrong.count === 0} @click=${() => this._askNotAnimal()}></kestrel-lu-button>
      </div>`;
  }

  private _renderAge() {
    return html`<div class="age">
      <p class="ask">Delete clips older than…</p>
      <div class="choices" role="group" aria-label="Delete clips older than">
        ${AGE_CHOICES.map((choice) => html`<kestrel-lu-button kind="secondary" label=${choice.label} ?disabled=${this._checking} @click=${() => this._chooseAge(choice)}></kestrel-lu-button>`)}
      </div>
      ${this._checking ? html`<p class="note" role="status">Checking how many clips that is…</p>` : nothing}
      <div class="buttons"><kestrel-lu-button kind="quiet" label="Cancel" ?disabled=${this._checking} @click=${() => this._cancel()}></kestrel-lu-button></div>
    </div>`;
  }

  private _renderBody() {
    const storage = this._storage;
    if (!storage) {
      if (this._loading) return html`<kestrel-lu-state kind="loading" variant="text" count="2" heading="Counting clips"></kestrel-lu-state>`;
      return html`<kestrel-lu-state kind="error" compact heading="Couldn't count the clips" .message=${this._loadError || "Kestrel couldn't reach its camera recorder."} @lu-retry=${() => this._load()}></kestrel-lu-state>`;
    }
    const pending = this._pending;
    return html`
      ${this._renderSummary(storage)}
      ${this._result ? html`<p class="result" role="status"><ha-icon .icon=${"mdi:check-circle-outline"}></ha-icon><span>${this._result}</span></p>` : nothing}
      ${this._loadError ? html`<p class="problem" role="alert"><ha-icon .icon=${"mdi:alert-circle-outline"}></ha-icon><span>${this._loadError}</span></p>` : nothing}
      ${storage.canDelete
        ? this._step === "confirm" && pending
          ? html`<kestrel-clip-confirm .count=${pending.count} .bytes=${pending.bytes} ?busy=${this._deleting} .error=${this._problem} @confirm=${() => this._delete()} @cancel=${() => this._cancel()}></kestrel-clip-confirm>`
          : html`
            ${this._step === "age" ? this._renderAge() : this._renderActions(storage)}
            ${this._note ? html`<p class="note" role="status">${this._note}</p>` : nothing}
            ${this._problem ? html`<p class="problem" role="alert"><ha-icon .icon=${"mdi:alert-circle-outline"}></ha-icon><span>${this._problem}</span></p>` : nothing}`
        : html`<p class="note">Only a Home Assistant administrator can delete clips.</p>`}`;
  }

  static styles = [BASE_CSS, css`
    :host { display: block; }
    p { margin: 0; }
    .summary { display: flex; align-items: baseline; flex-wrap: wrap; gap: var(--lu-space-2) var(--lu-space-3); margin-bottom: var(--lu-space-4); }
    .summary strong { font-size: var(--lu-type-display); font-weight: 350; font-variant-numeric: tabular-nums; line-height: 1; }
    .summary span, .empty { color: var(--lu-ink-2); font-size: var(--lu-type-label); }
    .empty { margin-bottom: var(--lu-space-4); }
    .action { display: flex; align-items: center; justify-content: space-between; gap: var(--lu-space-3); padding: var(--lu-space-3) 0; border-top: 1px solid var(--lu-edge); }
    .copy { display: grid; gap: var(--lu-space-1); min-width: 0; }
    .copy strong { font-size: var(--lu-type-label); font-weight: 600; overflow-wrap: anywhere; }
    .copy span { color: var(--lu-ink-2); font-size: var(--lu-type-caption); }
    .action kestrel-lu-button { flex: none; }
    .age { display: grid; gap: var(--lu-space-3); padding-top: var(--lu-space-3); border-top: 1px solid var(--lu-edge); }
    .ask { font-size: var(--lu-type-label); font-weight: 600; }
    .choices { display: flex; flex-wrap: wrap; gap: var(--lu-space-2); }
    .buttons { display: flex; gap: var(--lu-space-2); }
    .note { margin-top: var(--lu-space-3); color: var(--lu-ink-3); font-size: var(--lu-type-caption); }
    .age .note { margin-top: 0; }
    .result, .problem { display: flex; align-items: flex-start; gap: var(--lu-space-2); margin-bottom: var(--lu-space-3); font-size: var(--lu-type-label); }
    .result { color: var(--lu-positive); }
    .problem { margin-top: var(--lu-space-3); color: var(--lu-danger); }
    .result ha-icon, .problem ha-icon { flex: none; --mdc-icon-size: 20px; }
  `];

  render() {
    return this._renderBody();
  }
}

customElements.define("kestrel-clip-storage", KestrelClipStorage);

declare global { interface HTMLElementTagNameMap { "kestrel-clip-storage": KestrelClipStorage; } }
