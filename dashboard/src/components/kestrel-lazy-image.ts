import { LitElement, css, html } from "lit";
import { TOKENS_CSS } from "../styles/tokens.ts";

export class KestrelLazyImage extends LitElement {
  static properties = {
    src: { type: String },
    alt: { type: String },
    square: { type: Boolean, reflect: true },
    wide: { type: Boolean, reflect: true },
    _visible: { state: true },
    _failed: { state: true },
  };

  declare src: string;
  declare alt: string;
  declare square: boolean;
  declare wide: boolean;
  declare _visible: boolean;
  declare _failed: boolean;
  private _observer?: IntersectionObserver;

  constructor() {
    super();
    this.src = "";
    this.alt = "";
    this.square = false;
    this.wide = false;
    this._visible = false;
    this._failed = false;
  }

  connectedCallback(): void {
    super.connectedCallback();
    if (typeof IntersectionObserver === "undefined") {
      this._visible = true;
      return;
    }
    this._observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        this._visible = true;
        this._observer?.disconnect();
        this._observer = undefined;
      }
    }, { rootMargin: "180px" });
    this._observer.observe(this);
  }

  disconnectedCallback(): void {
    this._observer?.disconnect();
    this._observer = undefined;
    super.disconnectedCallback();
  }

  updated(changed: Map<string, unknown>): void {
    if (changed.has("src")) this._failed = false;
  }

  private _onError(): void {
    this._failed = true;
    this.dispatchEvent(new CustomEvent("kestrel-image-error", { bubbles: true, composed: true }));
  }

  static styles = [TOKENS_CSS, css`
    :host { display: block; width: 100%; aspect-ratio: 4 / 3; overflow: hidden; border-radius: var(--lu-radius-tile); background: var(--lu-tile); }
    :host([square]) { aspect-ratio: 1; }
    :host([wide]) { aspect-ratio: 16 / 10; }
    .frame { display: grid; width: 100%; height: 100%; min-height: 0; place-items: center; overflow: hidden; color: var(--lu-ink-3); }
    img { display: block; width: 100%; height: 100%; object-fit: cover; }
    ha-icon { width: 28px; height: 28px; opacity: .66; }
  `];

  render() {
    const source = this._visible && this.src && !this._failed ? this.src : "";
    return html`<div class="frame">
      ${source
        ? html`<img src=${source} alt=${this.alt} loading="lazy" decoding="async" @error=${this._onError}>`
        : html`<slot name="empty"><ha-icon .icon=${this._failed ? "mdi:image-broken-variant" : "mdi:image-outline"} aria-hidden="true"></ha-icon></slot>`}
    </div>`;
  }
}

customElements.define("kestrel-lazy-image", KestrelLazyImage);

declare global { interface HTMLElementTagNameMap { "kestrel-lazy-image": KestrelLazyImage; } }
