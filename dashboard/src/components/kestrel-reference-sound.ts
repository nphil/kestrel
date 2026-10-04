import { BASE_CSS, type LuSegmentOption } from "lucent-ha";
import { LitElement, css, html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { api, referenceSounds } from "../api.ts";
import type { HomeAssistant, ReferenceSounds } from "../types.ts";
import { REFERENCE, referenceCredit, withArticle } from "../vocab.ts";

type Phase = "idle" | "loading" | "ready" | "none" | "unavailable";

/** Answers seen this session, so reopening a species sheet shows its player at once instead of asking again. An answer is kept for 30 minutes
 * after it was last on screen, and never for more than 6 hours after the server gave it: its signed links last 12 hours (the panel keeps links
 * for 6, see urls.ts). Only answers that can be trusted again are kept: `ready` and `none`, never `unavailable`. */
const CACHE = new Map<string, { answeredAt: number; seenAt: number; sounds: ReferenceSounds }>();
const CACHE_MAX = 24;
const KEEP_MS = 30 * 60_000;
const LINKS_MS = 6 * 3_600_000;

/** The blocks on screen, so a restart of Home Assistant can send them back to their button. */
const SHOWN = new Set<KestrelReferenceSound>();

/** Forgets every kept answer and sends what is on screen back to its button: the signed links they hold were made with a key Home Assistant has since replaced. */
export function forgetReferenceCache(): void {
  CACHE.clear();
  for (const block of SHOWN) block.forgetLinks();
}

function remember(name: string, sounds: ReferenceSounds): void {
  const now = Date.now();
  CACHE.delete(name);
  CACHE.set(name, { answeredAt: now, seenAt: now, sounds });
  while (CACHE.size > CACHE_MAX) CACHE.delete(CACHE.keys().next().value as string);
}

function kept(name: string): ReferenceSounds | null {
  const entry = CACHE.get(name);
  if (!entry) return null;
  const now = Date.now();
  if (now - entry.seenAt >= KEEP_MS || now - entry.answeredAt >= LINKS_MS) {
    CACHE.delete(name);
    return null;
  }
  return entry.sounds;
}

/** "Play reference": what a species actually sounds like, from a public sound library (Xeno-canto, or iNaturalist), as opposed to a recording
 * the microphones made. Nothing is asked of the server until the button is pressed; the answer is a few clips played through signed Home Assistant
 * links, with the recordist, licence and a link to the page at its source. `compact` is the form for inside an existing tile (the visit page): no
 * heading, a hairline above. Otherwise it is a titled block like the species sheet's sections. `no-hint` drops the "What a ... sounds like" line
 * beside the button, for a place that already names the species right above it (the "Could also be" rows). */
export class KestrelReferenceSound extends LitElement {
  static properties = {
    // Read when the button is pressed. Home Assistant hands over a new one for every change in the house; none of them needs this block drawn again.
    hass: { attribute: false, hasChanged: () => false },
    species: { type: String },
    compact: { type: Boolean, reflect: true },
    noHint: { type: Boolean, attribute: "no-hint" },
    _phase: { state: true },
    _sounds: { state: true },
    _clipId: { state: true },
    _status: { state: true },
  };

  declare hass: HomeAssistant | undefined;
  declare species: string;
  declare compact: boolean;
  declare noHint: boolean;
  declare _phase: Phase;
  declare _sounds: ReferenceSounds | null;
  declare _clipId: string;
  /** What the polite live region says. */
  declare _status: string;

  /** Counts lookups and resets: an answer that arrives for an older one (another species, a removed block, a restart) is ignored. */
  private _request = 0;
  private _options: LuSegmentOption[] = [];
  /** The focus was inside this block just before the last draw: a control that held it may be gone now. */
  private _focused = false;

  constructor() {
    super();
    this.species = "";
    this.compact = false;
    this.noHint = false;
    this._phase = "idle";
    this._sounds = null;
    this._clipId = "";
    this._status = "";
  }

  connectedCallback(): void {
    super.connectedCallback();
    SHOWN.add(this);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    SHOWN.delete(this);
    this._request += 1;
    if (this._phase === "loading") this._phase = "idle";
    const entry = CACHE.get(this.species);
    if (entry && entry.sounds === this._sounds) entry.seenAt = Date.now();
  }

  /** The signing key changed: a clip's link is dead from now on, so a player goes back to its button and one press asks again. */
  forgetLinks(): void {
    if (this._phase === "ready" || this._phase === "loading") this._reset(null);
  }

  protected willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("species")) this._reset(kept(this.species));
    this._focused = this.shadowRoot?.activeElement != null;
  }

  protected updated(): void {
    // The control that had the focus was replaced (the button by the player): keep the focus in this block instead of dropping it on the page.
    if (this._focused && !this.shadowRoot?.activeElement) this.shadowRoot?.querySelector<HTMLElement>(".body")?.focus({ preventScroll: true });
  }

  /** Shows `sounds` (an answer kept from before) or the button. */
  private _reset(sounds: ReferenceSounds | null): void {
    this._request += 1;
    this._status = "";
    this._use(sounds);
    this._phase = !sounds ? "idle" : sounds.state === "ready" ? "ready" : "none";
  }

  private _use(sounds: ReferenceSounds | null): void {
    this._sounds = sounds;
    this._clipId = sounds?.clips[0]?.id ?? "";
    this._options = (sounds?.clips ?? []).map((clip) => ({ value: clip.id, label: clip.label }));
  }

  private _press = (): void => { void this._lookup(); };

  private async _lookup(): Promise<void> {
    const species = this.species;
    const request = ++this._request;
    this._phase = "loading";
    this._status = "Finding a recording…";
    let sounds = referenceSounds(null);
    try {
      if (this.hass) sounds = referenceSounds(await api.speciesReference(this.hass, species));
    } catch {
      // Offline, or the integration is not set up yet: shown as "unavailable", and Try again asks once more.
    }
    if (request !== this._request) return;
    if (sounds.state !== "unavailable") remember(species, sounds);
    this._use(sounds);
    this._phase = sounds.state;
    this._status = sounds.state === "ready" ? `Reference recording ready${sounds.clips[0].sourceName ? `, from ${sounds.clips[0].sourceName}` : ""}.` : sounds.state === "none" ? `No reference recording found for ${species}.` : "";
    if (sounds.state === "ready") void this._autoplay(request);
  }

  /** The press that asked for the recording is the listener's gesture, so try to start it. A browser that refuses is fine: the player is simply ready. */
  private async _autoplay(request: number): Promise<void> {
    await this.updateComplete;
    const player = this.shadowRoot?.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>("kestrel-lu-audio-player");
    await player?.updateComplete;
    if (request !== this._request) return;
    void player?.shadowRoot?.querySelector("audio")?.play().catch(() => undefined);
  }

  private _choose = (event: Event): void => { this._clipId = (event as CustomEvent<{ value: string }>).detail.value; };

  private _renderStart(): TemplateResult {
    const loading = this._phase === "loading";
    return html`<div class="start"><kestrel-lu-button kind="secondary" icon="mdi:play" label=${loading ? "Finding a recording…" : "Play reference"} ?loading=${loading} @click=${this._press}></kestrel-lu-button>${this.noHint ? nothing : html`<span class="hint">What ${withArticle(this.species)} sounds like</span>`}</div>`;
  }

  private _renderReady(): TemplateResult {
    const clips = this._sounds?.clips ?? [];
    const clip = clips.find((item) => item.id === this._clipId) ?? clips[0];
    if (!clip) return html``;
    return html`<kestrel-lu-chip icon=${REFERENCE.icon} label=${clip.sourceName ? `${REFERENCE.word} · ${clip.sourceName}` : REFERENCE.word}></kestrel-lu-chip>
      ${clips.length > 1 ? html`<kestrel-lu-segmented label="Reference recording" .options=${this._options} .value=${clip.id} @lu-change=${this._choose}></kestrel-lu-segmented>` : nothing}
      ${keyed(clip.id, html`<kestrel-lu-audio-player .src=${clip.url} .mark=${REFERENCE.word} preload="none" label=${`Reference recording of ${this.species}: ${clip.label}`}></kestrel-lu-audio-player>`)}
      <p class="credit">${referenceCredit(clip)}</p>
      ${clip.page ? html`<kestrel-lu-button class="link" kind="quiet" icon="mdi:open-in-new" href=${clip.page} target="_blank" label=${clip.sourceName ? `View at ${clip.sourceName}` : "View the source"}></kestrel-lu-button>` : nothing}`;
  }

  private _renderBody(): TemplateResult {
    switch (this._phase) {
      case "ready": return this._renderReady();
      case "none": return html`<p class="note">No reference recording found for ${this.species}.</p>`;
      case "unavailable": return html`<kestrel-lu-state kind="error" compact message="Couldn't look up a reference recording." retry-label="Try again" @lu-retry=${this._press}></kestrel-lu-state>`;
      default: return this._renderStart();
    }
  }

  static styles = [BASE_CSS, css`
    :host { display: block; min-width: 0; }
    :host(:not([compact])) { margin-top: var(--lu-space-5); padding-top: var(--lu-space-4); border-top: 1px solid var(--lu-edge); }
    :host([compact]) { grid-column: 1 / -1; padding-top: var(--lu-space-3); border-top: 1px solid var(--lu-edge); }
    p { margin: 0; }
    .body { display: grid; justify-items: start; gap: var(--lu-space-3); min-width: 0; border-radius: var(--lu-radius-control); }
    .body > kestrel-lu-audio-player, .body > kestrel-lu-segmented, .body > kestrel-lu-state { justify-self: stretch; }
    .start { display: flex; flex-wrap: wrap; align-items: center; gap: var(--lu-space-1) var(--lu-space-3); }
    .hint, .credit { color: var(--lu-ink-2); font-size: var(--lu-type-caption); line-height: 1.4; overflow-wrap: anywhere; }
    .note { color: var(--lu-ink-2); font-size: var(--lu-type-label); line-height: 1.4; }
    /* The text button's own padding is its touch area: pull it out so its icon lines up with the text above, and tuck it under the credit. */
    .link { margin-block-start: calc(var(--lu-space-2) * -1); margin-inline-start: calc(var(--lu-space-3) * -1); }
  `];

  render() {
    if (!this.species) return nothing;
    const body = html`<div class="body" tabindex="-1" role="group" aria-label=${`Reference sound of ${this.species}`}>${this._renderBody()}</div>`;
    const status = html`<p class="sr-only" role="status" aria-live="polite">${this._status}</p>`;
    return this.compact
      ? html`${body}${status}`
      : html`<kestrel-lu-section icon=${REFERENCE.icon} heading="Reference sound" .count=${1}>${body}</kestrel-lu-section>${status}`;
  }
}

customElements.define("kestrel-reference-sound", KestrelReferenceSound);

declare global { interface HTMLElementTagNameMap { "kestrel-reference-sound": KestrelReferenceSound; } }
