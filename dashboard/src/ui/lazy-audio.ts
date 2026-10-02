import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { claimAudio, releaseAudio } from "./audio-focus.ts";
import { FOCUS_CSS } from "../styles/tokens.ts";

/** Wraps a native `<audio>` element and swaps in an honest fallback message when the recording can't be
 * loaded (missing, or a format this browser can't decode), instead of a silent or broken-looking player.
 * When `original` is set, `src` is a cleaned preview and a small toggle plays the untouched recording instead.
 * `mark` (a short passive label such as "Cleaned") and `caption` sit under the player while the preview is
 * the one playing. If `src` changes while it is playing (the preview became ready), the new one waits for the
 * current one to stop, so the swap is never heard. Starting playback pauses any other recording in the panel. */
export class KestrelLazyAudio extends LitElement {
  static properties = {
    src: { type: String },
    original: { type: String },
    mark: { type: String },
    caption: { type: String },
    label: { type: String },
    preload: { type: String },
    _failed: { state: true },
    _useOriginal: { state: true },
    _held: { state: true },
  };

  declare src: string;
  declare original: string;
  declare mark: string;
  declare caption: string;
  declare label: string;
  declare preload: "none" | "metadata";
  declare _failed: boolean;
  declare _useOriginal: boolean;
  /** The source still loaded while a newer one waits for playback to stop. */
  declare _held: string | null;

  constructor() {
    super();
    this.src = "";
    this.original = "";
    this.mark = "";
    this.caption = "";
    this.label = "";
    this.preload = "none";
    this._failed = false;
    this._useOriginal = false;
    this._held = null;
  }

  protected willUpdate(changed: PropertyValues<this>): void {
    if (!changed.has("src")) return;
    const previous = changed.get("src") as string | undefined;
    const audio = this.renderRoot?.querySelector("audio");
    if (previous && audio && !audio.paused && !audio.ended && !this._useOriginal) this._held = previous;
    else this._held = null;
  }

  private _settle(event: Event): void {
    releaseAudio(event.currentTarget as HTMLAudioElement);
    if (this._held !== null) this._held = null;
  }
  protected updated(changed: PropertyValues<this>): void {
    if (changed.has("src") || changed.has("original")) {
      this._failed = false;
      if (!this.original) this._useOriginal = false;
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    const audio = this.renderRoot.querySelector("audio");
    if (audio) releaseAudio(audio);
  }

  /** A preview that can't be played falls back to the untouched recording; only a recording that can't be played at all is an error. */
  private _onError(): void {
    if (this.original && !this._useOriginal) { this._useOriginal = true; this._held = null; return; }
    this._failed = true;
  }

  private async _toggleOriginal(): Promise<void> {
    const wasPlaying = (this.renderRoot.querySelector("audio")?.paused ?? true) === false;
    this._useOriginal = !this._useOriginal;
    this._failed = false;
    await this.updateComplete;
    if (wasPlaying) void this.renderRoot.querySelector("audio")?.play().catch(() => undefined);
  }

  static styles = [FOCUS_CSS, css`
    :host { display: block; }
    audio { display: block; width: 100%; }
    .fallback { display: flex; align-items: center; gap: var(--lu-space-2); margin: 0; color: var(--lu-ink-2); font-size: var(--lu-type-caption); }
    .fallback ha-icon { --mdc-icon-size: 18px; width: 18px; height: 18px; flex: none; }
    .notes { display: flex; flex-wrap: wrap; align-items: center; gap: var(--lu-space-2); margin: var(--lu-space-1) 0 0; color: var(--lu-ink-2); font-size: var(--lu-type-caption); }
    .mark { display: inline-flex; align-items: center; gap: var(--lu-space-1); min-height: 24px; padding: 0 var(--lu-space-2); border: 1px solid var(--lu-edge); border-radius: var(--lu-radius-pill); color: var(--lu-ink); background: var(--lu-tile); font-weight: 600; }
    .mark ha-icon { --mdc-icon-size: 14px; width: 14px; height: 14px; }
    .toggle { display: inline-flex; min-height: var(--lu-target); align-items: center; gap: var(--lu-space-1); margin-top: var(--lu-space-1); padding: 0 var(--lu-space-3); border: 1px solid var(--lu-edge); border-radius: var(--lu-radius-pill); color: var(--lu-ink-2); background: transparent; font: 500 var(--lu-type-caption)/1.2 var(--lu-font); cursor: pointer; transition: background-color var(--lu-motion-label) var(--lu-ease); }
    .toggle:is(:active, [data-pressed]) { background-image: linear-gradient(var(--lu-material-press-wash), var(--lu-material-press-wash)); }
    .toggle[aria-pressed="true"] { color: var(--lu-ink); background: var(--lu-glass-raised); border-color: var(--lu-edge-raised); box-shadow: var(--lu-highlight-raised); font-weight: 600; }
    .toggle ha-icon { --mdc-icon-size: 16px; width: 16px; height: 16px; }
    @media (hover: hover) and (pointer: fine) { .toggle[aria-pressed="false"]:hover { background: var(--lu-material-hover-wash); } }
  `];

  render() {
    if (!this.src) return nothing;
    const original = this._useOriginal && this.original;
    const player = this._failed
      ? html`<p class="fallback"><ha-icon .icon=${"mdi:volume-off"} aria-hidden="true"></ha-icon>Couldn't load this recording.</p>`
      : html`<audio controls preload=${this.preload} src=${original ? this.original : this._held ?? this.src} aria-label=${original ? `${this.label} (original recording)` : this.label} @play=${(event: Event) => claimAudio(event.currentTarget as HTMLAudioElement)} @pause=${this._settle} @ended=${this._settle} @error=${this._onError}></audio>`;
    const toggle = this.original
      ? html`<button class="toggle" type="button" aria-pressed=${this._useOriginal ? "true" : "false"} @click=${this._toggleOriginal}>${this._useOriginal ? html`<ha-icon .icon=${"mdi:check"} aria-hidden="true"></ha-icon>` : nothing}Original</button>`
      : nothing;
    const notes = !original && !this._failed && (this.mark || this.caption)
      ? html`<p class="notes">${this.mark ? html`<span class="mark"><ha-icon .icon=${"mdi:creation"} aria-hidden="true"></ha-icon>${this.mark}</span>` : nothing}${this.caption ? html`<span>${this.caption}</span>` : nothing}</p>`
      : nothing;
    return html`${player}${notes}${toggle}`;
  }
}

customElements.define("kestrel-lazy-audio", KestrelLazyAudio);

declare global { interface HTMLElementTagNameMap { "kestrel-lazy-audio": KestrelLazyAudio; } }
