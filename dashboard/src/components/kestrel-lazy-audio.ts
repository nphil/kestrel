import { LitElement, css, html, nothing } from "lit";
import { TOKENS_CSS } from "../styles/tokens.ts";

/** Wraps a native `<audio>` element and swaps in an honest fallback message when the browser
 * can't decode the source (e.g. Ogg/Opus on browsers without that codec), instead of a silent
 * or broken-looking player. */
export class KestrelLazyAudio extends LitElement {
  static properties = {
    src: { type: String },
    label: { type: String },
    preload: { type: String },
    _failed: { state: true },
  };

  declare src: string;
  declare label: string;
  declare preload: "none" | "metadata";
  declare _failed: boolean;

  constructor() {
    super();
    this.src = "";
    this.label = "";
    this.preload = "none";
    this._failed = false;
  }

  updated(changed: Map<string, unknown>): void {
    if (changed.has("src")) this._failed = false;
  }

  private _onError(): void { this._failed = true; }

  static styles = [TOKENS_CSS, css`
    :host { display: block; }
    audio { display: block; width: 100%; }
    .fallback { display: flex; align-items: center; gap: var(--lu-space-2); margin: 0; color: var(--lu-ink-2); font-size: var(--lu-type-caption); }
    .fallback ha-icon { width: 18px; height: 18px; flex: none; }
  `];

  render() {
    if (!this.src) return nothing;
    if (this._failed) {
      return html`<p class="fallback"><ha-icon .icon=${"mdi:volume-off"} aria-hidden="true"></ha-icon>Can't play this format here.</p>`;
    }
    return html`<audio controls preload=${this.preload} src=${this.src} aria-label=${this.label} @error=${this._onError}></audio>`;
  }
}

customElements.define("kestrel-lazy-audio", KestrelLazyAudio);

declare global { interface HTMLElementTagNameMap { "kestrel-lazy-audio": KestrelLazyAudio; } }
