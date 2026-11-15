import { BASE_CSS, InViewController, activeAudio, renderIcon } from "lucent-ha";
import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { audioPaths, playheadAt } from "../playhead.ts";

/** One clock for every spectrogram on the page: four times a second it asks which recording is playing. The toolkit's players keep their audio element
 * (and its events) inside themselves, so this is how a picture far from the player can still move with the sound. It only runs while at least one
 * spectrogram is on screen and the page is in front. */
const SYNC_MS = 250;
const watchers = new Set<() => void>();
let clock: number | undefined;

function watchPlayback(watcher: () => void): () => void {
  watchers.add(watcher);
  clock ??= window.setInterval(() => { if (document.visibilityState === "visible") for (const each of watchers) each(); }, SYNC_MS);
  return () => {
    watchers.delete(watcher);
    if (watchers.size === 0 && clock !== undefined) { window.clearInterval(clock); clock = undefined; }
  };
}

/** How long a picture waits before its one retry: BirdNET-Go draws it on the first request and may be busy with another. */
const RETRY_MS = 1500;

/** A picture of a recording's sound: time runs left to right (the whole width is the whole recording), pitch bottom to top. A slim strip (the whole
 * picture squeezed to a band, so it still shows when the sound is busy) until it is tapped, then the picture at its own proportions. While the
 * recording plays (in whichever player is on the page) a line travels along it and the part already played is tinted.
 *
 * - `src` is the picture's address (drawn by BirdNET-Go on the first request); `follows` is the recording's own addresses (its file and its untouched
 *   original), which is how it knows which sound is its own; `label` names the recording for screen readers.
 * - While `pending` has no `src` yet, an empty strip holds the place, so nothing moves when the picture arrives.
 * - A picture that cannot be had (BirdNET-Go has none, or stays busy) takes the whole spectrogram away: there is nothing to apologise for. The
 *   `lu-image-error` it announces is the toolkit's own event, so the panel can tell whether the cause is a signature that has expired. */
export class KestrelSpectrogram extends LitElement {
  static properties = {
    src: { type: String },
    follows: { attribute: false },
    label: { type: String },
    pending: { type: Boolean },
    expanded: { type: Boolean, reflect: true },
    _near: { state: true },
    _shown: { state: true },
    _attempt: { state: true },
    _failed: { state: true },
  };

  declare src: string;
  declare follows: readonly string[];
  declare label: string;
  declare pending: boolean;
  declare expanded: boolean;
  declare _near: boolean;
  declare _shown: boolean;
  declare _attempt: number;
  declare _failed: boolean;

  private _paths: string[] = [];
  private _audio: HTMLMediaElement | null = null;
  private _fraction = 0;
  private _stop: (() => void) | undefined;
  private _retry: number | undefined;
  private readonly _view = new InViewController(this, { rootMargin: "160px", onChange: (visible) => this._onView(visible) });

  constructor() {
    super();
    this.src = "";
    this.follows = [];
    this.label = "this recording";
    this.pending = false;
    this.expanded = false;
    this._near = false;
    this._shown = false;
    this._attempt = 0;
    this._failed = false;
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this._stop?.();
    this._stop = undefined;
    clearTimeout(this._retry);
  }

  protected willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("follows")) this._paths = audioPaths(...this.follows);
    if (changed.has("src")) {
      clearTimeout(this._retry);
      this._shown = false;
      this._attempt = 0;
      this._failed = false;
    }
  }

  protected updated(changed: PropertyValues<this>): void {
    if (changed.has("follows") && this._view.visible) this._follow();
    // A picture the browser already had is complete as soon as it is placed: no fade from nothing.
    const picture = this.renderRoot.querySelector("img");
    if (picture?.complete && picture.naturalWidth > 0 && !this._shown) this._shown = true;
  }

  private _onView(visible: boolean): void {
    if (visible) {
      this._near = true; // asked for the picture the first time it is close, never before
      this._stop ??= watchPlayback(() => this._follow());
      this._follow();
      return;
    }
    this._stop?.();
    this._stop = undefined;
  }

  /** Moves the line by direct style, so a playing recording does not render this element four times a second. */
  private _follow(): void {
    const { audio, fraction } = playheadAt(this._audio, activeAudio(), this._paths);
    const live = audio !== null;
    if (live !== (this._audio !== null)) this.toggleAttribute("data-live", live);
    this._audio = audio;
    if (fraction !== this._fraction) {
      this._fraction = fraction;
      this.style.setProperty("--f", String(fraction));
    }
  }

  private _toggle = (): void => { this.expanded = !this.expanded; };

  /** One more try after a pause (a new picture element, the very same address: a signed link takes no extra parameter), then give up. */
  private _onError = (): void => {
    if (this._attempt > 0) {
      this._failed = true;
      this.dispatchEvent(new CustomEvent("lu-image-error", { detail: { src: this.src }, bubbles: true, composed: true }));
      return;
    }
    const src = this.src;
    this._retry = window.setTimeout(() => { if (this.src === src) this._attempt += 1; }, RETRY_MS);
  };

  static styles = [BASE_CSS, css`
    :host { display: block; min-width: 0; }
    .strip { position: relative; display: block; width: 100%; height: var(--lu-target); padding: 0; overflow: hidden; border: 1px solid var(--lu-edge); border-radius: var(--lu-radius-tile); color: inherit; background: var(--lu-tile); cursor: pointer; -webkit-tap-highlight-color: transparent; }
    :host([expanded]) .strip { height: auto; aspect-ratio: 2 / 1; }
    .strip.holder { cursor: default; }
    .strip:is(:active, [data-pressed])::after { content: ""; position: absolute; inset: 0; background: var(--lu-material-press-wash); pointer-events: none; }
    img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: fill; opacity: 0; transition: opacity var(--lu-motion-card, 180ms) var(--lu-ease, ease-out); }
    img.shown { opacity: 1; }
    .veil, .playhead { position: absolute; inset: 0; opacity: 0; pointer-events: none; }
    .veil { background: var(--lu-accent-soft); transform: scaleX(var(--f, 0)); transform-origin: left center; }
    .playhead { transform: translateX(calc(var(--f, 0) * 100%)); }
    .playhead::before { content: ""; position: absolute; top: 0; bottom: 0; left: -1px; width: 2px; background: var(--lu-accent); box-shadow: 0 0 0 1px var(--lu-card); }
    :host([data-live]) :is(.veil, .playhead) { opacity: 1; transition: transform ${SYNC_MS}ms linear; }
    .grow { position: absolute; top: 50%; right: var(--lu-space-2); display: grid; place-items: center; width: 24px; height: 24px; border: 1px solid var(--lu-edge-raised); border-radius: 50%; color: var(--lu-ink-2); background: var(--lu-glass-raised); transform: translateY(-50%); pointer-events: none; }
    .grow .icon { --lu-icon: 16px; }
    :host([expanded]) .grow { top: var(--lu-space-2); transform: none; }
    @media (prefers-reduced-motion: reduce) { img, :host([data-live]) :is(.veil, .playhead) { transition: none; } }
  `];

  protected render() {
    if (this._failed || (!this.src && !this.pending)) return nothing;
    if (!this.src) return html`<div class="strip holder" aria-hidden="true"></div>`;
    const action = this.expanded ? "Shrink" : "Enlarge";
    return html`<button class="strip" type="button" aria-expanded=${String(this.expanded)} aria-label=${`${action} the spectrogram of ${this.label}`} @click=${this._toggle}>
      ${this._near ? keyed(this._attempt, html`<img class=${this._shown ? "shown" : ""} src=${this.src} alt="" decoding="async" @load=${() => { this._shown = true; }} @error=${this._onError}>`) : nothing}
      <span class="veil"></span><span class="playhead"></span>
      <span class="grow">${renderIcon(this.expanded ? "mdi:chevron-up" : "mdi:chevron-down")}</span>
    </button>`;
  }
}

customElements.define("kestrel-spectrogram", KestrelSpectrogram);

declare global { interface HTMLElementTagNameMap { "kestrel-spectrogram": KestrelSpectrogram; } }
