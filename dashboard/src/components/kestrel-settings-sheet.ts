import { BASE_CSS, type LuCloseDetail } from "lucent-ha";
import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { api } from "../api.ts";
import type { HomeAssistant, RangeFilter } from "../types.ts";

/** The named steps of BirdNET-Go's local species filter. `threshold` is how likely a species has to be here, at this time of year. */
const STEPS = [
  { threshold: 0.01, label: "Loose", about: "Lets in almost everything that could possibly turn up, rare visitors included." },
  { threshold: 0.03, label: "Balanced", about: "Skips the long shots but keeps the species that plausibly pass through." },
  { threshold: 0.05, label: "Strict", about: "Mostly the species you would expect here. Fewer wrong guesses." },
  { threshold: 0.1, label: "Very strict", about: "Only the most expected species. Rare visitors may be missed." },
] as const;
const OPTIONS = STEPS.map((step) => ({ value: String(step.threshold), label: step.label }));
/** BirdNET-Go rebuilds its list in the background; while it has not finished, look again every few seconds, a few times. */
const RECHECK_MS = 3000;
const RECHECKS = 5;

const percent = (threshold: number): string => `${Math.round(threshold * 1000) / 10}%`;

/** What went wrong, in words for the person who pressed the button. */
function failure(error: unknown): string {
  const fallback = "Kestrel couldn't reach BirdNET-Go.";
  if (typeof error !== "object" || error === null) return fallback;
  if ("code" in error && error.code === "unauthorized") return "Only a Home Assistant administrator can change this.";
  const message = "message" in error && typeof error.message === "string" ? error.message.trim() : "";
  return message ? (/[.!?]$/.test(message) ? message : `${message}.`) : fallback;
}

/** Kestrel's settings. Today that is one thing: how strict BirdNET-Go's local species filter is, with how many species it lets through.
 * Kestrel glue over the toolkit's sheet and segmented control. `open` shows it; fires `close` ({ reason }) after the exit motion. */
export class KestrelSettingsSheet extends LitElement {
  static properties = {
    hass: { attribute: false },
    open: { type: Boolean },
    history: { type: Boolean },
    _filter: { state: true },
    _loading: { state: true },
    _loadError: { state: true },
    _saving: { state: true },
    _saveError: { state: true },
  };

  declare hass: HomeAssistant | undefined;
  declare open: boolean;
  /** Add a history entry while open, so Back closes it (a panel does; a card must not). */
  declare history: boolean;
  declare _filter: RangeFilter | null;
  declare _loading: boolean;
  declare _loadError: string;
  /** The threshold being saved, or null. */
  declare _saving: number | null;
  declare _saveError: string;

  private _recheckTimer = 0;
  private _generation = 0;

  constructor() {
    super();
    this.open = false;
    this.history = false;
    this._filter = null;
    this._loading = false;
    this._loadError = "";
    this._saving = null;
    this._saveError = "";
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this._stopRechecking();
  }

  protected willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("open") && this.open) void this._load();
    if (changed.has("open") && !this.open) this._stopRechecking();
  }

  private _stopRechecking(): void {
    window.clearTimeout(this._recheckTimer);
    this._generation++;
  }

  private async _load(): Promise<void> {
    const hass = this.hass;
    if (!hass) return;
    const generation = ++this._generation;
    this._loading = true;
    this._loadError = "";
    this._saveError = "";
    try {
      const filter = await api.rangeFilter(hass);
      if (generation !== this._generation) return;
      this._filter = filter;
      this._recheckWhileRebuilding(filter, 0);
    } catch (error) {
      if (generation === this._generation) this._loadError = failure(error);
    } finally {
      if (generation === this._generation) this._loading = false;
    }
  }

  private _recheckWhileRebuilding(filter: RangeFilter, done: number): void {
    window.clearTimeout(this._recheckTimer);
    if (!filter.rebuilding || done >= RECHECKS) return;
    const generation = this._generation;
    this._recheckTimer = window.setTimeout(async () => {
      const hass = this.hass;
      if (!hass || generation !== this._generation) return;
      try {
        const latest = await api.rangeFilter(hass);
        if (generation !== this._generation) return;
        // The list is newer once BirdNET-Go has finished rebuilding it.
        this._filter = latest;
        this._recheckWhileRebuilding({ ...latest, rebuilding: latest.updatedAt === filter.updatedAt }, done + 1);
      } catch {
        // The next look, or the person pressing a step, will say if BirdNET-Go is really gone.
      }
    }, RECHECK_MS);
  }

  private async _choose(event: CustomEvent<{ value: string }>): Promise<void> {
    event.stopPropagation();
    const hass = this.hass;
    const filter = this._filter;
    const threshold = Number(event.detail.value);
    if (!hass || !filter?.canChange || this._saving !== null || !Number.isFinite(threshold)) return;
    if (Math.abs(threshold - filter.threshold) < 1e-6) return;
    const generation = ++this._generation;
    window.clearTimeout(this._recheckTimer);
    this._saving = threshold;
    this._saveError = "";
    try {
      const saved = await api.setRangeFilter(hass, threshold);
      if (generation !== this._generation) return;
      this._filter = saved;
      this._recheckWhileRebuilding(saved, 0);
    } catch (error) {
      if (generation === this._generation) this._saveError = failure(error);
    } finally {
      if (generation === this._generation) this._saving = null;
    }
  }

  private _onClose(event: CustomEvent<LuCloseDetail>): void {
    event.stopPropagation();
    this.dispatchEvent(new CustomEvent("close", { detail: event.detail }));
  }

  private _renderFilter(filter: RangeFilter) {
    const saving = this._saving !== null;
    const shown = this._saving ?? filter.threshold;
    const step = STEPS.find((candidate) => Math.abs(candidate.threshold - shown) < 1e-6);
    const place = filter.latitude !== null && filter.longitude !== null ? ` near ${filter.latitude.toFixed(2)}°, ${filter.longitude.toFixed(2)}°` : "";
    return html`
      <div class="count" role="status">
        <strong>${saving ? "…" : filter.speciesCount}</strong>
        <span>${saving ? "BirdNET-Go is updating its list" : filter.rebuilding ? "species allowed (updating…)" : `species allowed${place}`}</span>
      </div>
      <kestrel-lu-segmented label="Local species filter" .options=${OPTIONS} .value=${step ? String(step.threshold) : ""} ?disabled=${saving || !filter.canChange} @lu-change=${this._choose}></kestrel-lu-segmented>
      <p class="about">${step ? html`<strong>${step.label}.</strong> ${step.about}` : html`<strong>Custom.</strong> Set to ${percent(shown)} in BirdNET-Go.`} Species must be at least ${percent(shown)} likely here.</p>
      ${saving ? html`<p class="note" role="status"><kestrel-lu-chip kind="info" label="Saving…"></kestrel-lu-chip></p>` : nothing}
      ${this._saveError ? html`<p class="problem" role="alert"><ha-icon .icon=${"mdi:alert-circle-outline"}></ha-icon><span>${this._saveError} Nothing was changed.</span></p>` : nothing}
      ${filter.canChange ? nothing : html`<p class="note">Only a Home Assistant administrator can change this.</p>`}`;
  }

  private _renderBody() {
    if (this._filter) return this._renderFilter(this._filter);
    if (this._loading) return html`<kestrel-lu-state kind="loading" variant="text" count="3" heading="Asking BirdNET-Go"></kestrel-lu-state>`;
    return html`<kestrel-lu-state kind="error" compact heading="Couldn't read the filter" .message=${this._loadError || "Kestrel couldn't reach BirdNET-Go."} @lu-retry=${() => this._load()}></kestrel-lu-state>`;
  }

  static styles = [BASE_CSS, css`
    :host { display: contents; }
    h3, p { margin: 0; }
    h3 { margin-bottom: var(--lu-space-2); font-size: var(--lu-type-label); font-weight: 600; }
    .intro { margin-bottom: var(--lu-space-4); color: var(--lu-ink-2); font-size: var(--lu-type-label); }
    .count { display: flex; align-items: baseline; flex-wrap: wrap; gap: var(--lu-space-2) var(--lu-space-3); margin-bottom: var(--lu-space-4); }
    .count strong { font-size: var(--lu-type-display); font-weight: 350; font-variant-numeric: tabular-nums; line-height: 1; }
    .count span { color: var(--lu-ink-2); font-size: var(--lu-type-label); }
    .about { margin-top: var(--lu-space-3); color: var(--lu-ink-2); font-size: var(--lu-type-label); }
    .about strong { color: var(--lu-ink); font-weight: 600; }
    .note { margin-top: var(--lu-space-3); color: var(--lu-ink-3); font-size: var(--lu-type-caption); }
    .problem { display: flex; align-items: flex-start; gap: var(--lu-space-2); margin-top: var(--lu-space-3); color: var(--lu-danger); font-size: var(--lu-type-label); }
    .problem ha-icon { flex: none; --mdc-icon-size: 20px; }
  `];

  render() {
    return html`<kestrel-lu-sheet .open=${this.open} .history=${this.history} engine="native" layer="settings" heading="Settings" subheading="How Kestrel listens for wildlife" @lu-close=${this._onClose}>
      <section>
        <h3>Local species filter</h3>
        <p class="intro">BirdNET-Go only reports a sound if that species is likely near you at this time of year. A stricter filter means fewer wrong guesses, but rarer visitors are more likely to be missed.</p>
        ${this._renderBody()}
      </section>
    </kestrel-lu-sheet>`;
  }
}

customElements.define("kestrel-settings-sheet", KestrelSettingsSheet);

declare global { interface HTMLElementTagNameMap { "kestrel-settings-sheet": KestrelSettingsSheet; } }
