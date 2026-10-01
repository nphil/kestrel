import { LitElement, css, html, nothing } from "lit";
import { BASE_CSS, CONTROLS_CSS } from "../styles/tokens.ts";

export type SectionState = "loading" | "ready" | "error";

/** A titled block of content that always says what it is doing: shaped placeholders while loading, a calm
 * one-liner when empty, and an honest message with a retry when it failed.
 *
 * `count` is how many items the slotted content holds. With none, the slot stays hidden and the state
 * decides what shows instead. With some, an `error` means a later page failed. `variant` shapes the loading
 * placeholder: "rows" for a list, "thumbs" for a rail of pictures. Fires `retry`. */
export class KestrelSection extends LitElement {
  static properties = {
    icon: { type: String },
    heading: { type: String },
    summary: { type: String },
    state: { type: String },
    count: { type: Number },
    empty: { type: String },
    noun: { type: String },
    variant: { type: String },
  };

  declare icon: string;
  declare heading: string;
  declare summary: string;
  declare state: SectionState;
  declare count: number;
  declare empty: string;
  declare noun: string;
  declare variant: "rows" | "thumbs";

  constructor() {
    super();
    this.icon = "";
    this.heading = "";
    this.summary = "";
    this.state = "ready";
    this.count = 0;
    this.empty = "Nothing here yet";
    this.noun = "items";
    this.variant = "rows";
  }

  private _retry(): void { this.dispatchEvent(new CustomEvent("retry")); }

  private _renderBody() {
    if (this.count > 0) {
      return html`<slot></slot>${this.state === "error" ? html`<p class="line"><span class="muted">Couldn't load more.</span><button class="text-button" type="button" @click=${this._retry}>Try again</button></p>` : nothing}`;
    }
    if (this.state === "loading") {
      return html`<div class=${`skeleton ${this.variant}`} role="status" aria-label=${`Loading ${this.noun}`}>${[0, 1, 2].map(() => html`<span class="bone"></span>`)}</div>`;
    }
    if (this.state === "error") {
      return html`<p class="line"><span class="muted">Couldn't load ${this.noun}.</span><button class="text-button" type="button" @click=${this._retry}>Try again</button></p>`;
    }
    return html`<p class="line muted">${this.empty}</p>`;
  }

  static styles = [BASE_CSS, CONTROLS_CSS, css`
    :host { display: block; margin-top: var(--lu-space-5); padding-top: var(--lu-space-4); border-top: 1px solid var(--lu-edge); }
    h3 { display: flex; align-items: center; gap: var(--lu-space-2); margin: 0 0 var(--lu-space-3); font-size: var(--lu-type-label); font-weight: 600; }
    h3 ha-icon { --mdc-icon-size: 20px; width: 20px; height: 20px; flex: none; color: var(--lu-ink-2); }
    .summary { color: var(--lu-ink-2); font-weight: 450; font-variant-numeric: tabular-nums; }
    .line { display: flex; flex-wrap: wrap; align-items: center; gap: var(--lu-space-2); min-height: var(--lu-target); margin: 0; font-size: var(--lu-type-label); }
    .skeleton { display: flex; gap: var(--lu-space-3); }
    .skeleton.rows { flex-direction: column; gap: var(--lu-space-2); }
    .bone { display: block; border-radius: var(--lu-radius-row); background: var(--lu-tile); animation: bone 1.4s ease-in-out infinite; }
    .rows .bone { height: var(--lu-row); }
    .thumbs .bone { flex: none; width: calc(var(--lu-target) * 3.5); aspect-ratio: 16 / 10; border-radius: var(--lu-radius-tile); }
    @keyframes bone { 50% { opacity: .55; } }
    @media (prefers-reduced-motion: reduce) { .bone { animation: none; } }
  `];

  render() {
    const id = "section-title";
    return html`<section aria-labelledby=${id}>
      <h3 id=${id}>${this.icon ? html`<ha-icon .icon=${this.icon} aria-hidden="true"></ha-icon>` : nothing}<span>${this.heading}${this.summary ? html` <span class="summary">· ${this.summary}</span>` : nothing}</span></h3>
      ${this._renderBody()}
    </section>`;
  }
}

customElements.define("kestrel-section", KestrelSection);

declare global { interface HTMLElementTagNameMap { "kestrel-section": KestrelSection; } }
