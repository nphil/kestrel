import { LitElement, css, html, nothing } from "lit";
import { BASE_CSS, CONTROLS_CSS } from "../styles/tokens.ts";
import "./lazy-image.ts";

export interface RailItem {
  id: string;
  /** Thumbnail picture URL (empty shows the neutral placeholder). */
  image: string;
  /** First line under the picture, e.g. when it happened. */
  title: string;
  /** Second, quieter line, e.g. where. */
  caption?: string;
  /** Full accessible name of the button. */
  label: string;
  /** Draws a play glyph over the picture. Without it, `badge` says what the picture is instead. */
  play?: boolean;
  badge?: string;
  badgeIcon?: string;
}

/** A horizontally scrolling rail of picture buttons, each with a title, a caption and either a play glyph or
 * a small badge. Fires `select` ({ id }) when one is tapped, `warm` ({ id }) the instant one is pressed (so
 * the owner can start loading what it opens) and `more` from the trailing "Show more" tile.
 *
 * Needs the host's `--lu-*` tokens. */
export class KestrelMediaRail extends LitElement {
  static properties = {
    items: { attribute: false },
    more: { type: Boolean },
    loading: { type: Boolean },
    moreLabel: { type: String, attribute: "more-label" },
  };

  declare items: RailItem[];
  declare more: boolean;
  declare loading: boolean;
  declare moreLabel: string;

  constructor() {
    super();
    this.items = [];
    this.more = false;
    this.loading = false;
    this.moreLabel = "Show more";
  }

  private _emit(name: "select" | "warm", id: string): void {
    this.dispatchEvent(new CustomEvent(name, { detail: { id } }));
  }

  static styles = [BASE_CSS, CONTROLS_CSS, css`
    :host { display: block; }
    ul { display: flex; gap: var(--lu-space-3); margin: 0 calc(var(--lu-space-1) * -1); padding: var(--lu-space-1) var(--lu-space-1) var(--lu-space-2); overflow-x: auto; overscroll-behavior-x: contain; scroll-snap-type: x proximity; scrollbar-width: thin; list-style: none; }
    li { flex: none; width: calc(var(--lu-target) * 3.5); scroll-snap-align: start; }
    li.more { display: grid; align-items: start; width: auto; }
    .item { display: grid; width: 100%; gap: 2px; padding: 0; border: 0; border-radius: var(--lu-radius-tile); color: var(--lu-ink); background: transparent; text-align: left; cursor: pointer; transition: background-color var(--lu-motion-label) var(--lu-ease); }
    .item:is(:active, [data-pressed]) { background: var(--lu-material-press-wash); transition: none; }
    .item:is(:active, [data-pressed]) .frame::after { content: ""; position: absolute; inset: 0; border-radius: var(--lu-radius-tile); background: var(--lu-material-press-wash); pointer-events: none; }
    .frame { position: relative; display: block; margin-bottom: var(--lu-space-1); }
    kestrel-lazy-image { display: block; width: 100%; }
    .glyph-wrap { position: absolute; inset: 0; display: grid; place-items: center; pointer-events: none; }
    .glyph { display: grid; width: var(--lu-glyph, 40px); height: var(--lu-glyph, 40px); place-items: center; border: 1px solid var(--lu-edge); border-radius: 50%; color: var(--lu-ink); background: var(--lu-reading); }
    .glyph ha-icon { --mdc-icon-size: 24px; width: 24px; height: 24px; }
    .badge { position: absolute; top: var(--lu-space-2); left: var(--lu-space-2); display: inline-flex; align-items: center; gap: var(--lu-space-1); min-height: 28px; padding: 0 var(--lu-space-3) 0 var(--lu-space-2); border: 1px solid var(--lu-edge); border-radius: var(--lu-radius-pill); color: var(--lu-ink); background: var(--lu-reading); font-size: var(--lu-type-caption); font-weight: 600; pointer-events: none; }
    .badge ha-icon { --mdc-icon-size: 16px; width: 16px; height: 16px; }
    .title { padding: 0 var(--lu-space-1); font-size: var(--lu-type-label); font-weight: 550; }
    .caption { padding: 0 var(--lu-space-1); overflow: hidden; color: var(--lu-ink-2); font-size: var(--lu-type-caption); text-overflow: ellipsis; white-space: nowrap; }
    .more-tile { display: grid; width: calc(var(--lu-target) * 2.2); aspect-ratio: 16 / 10; place-items: center; padding: 0 var(--lu-space-3); border: 1px dashed var(--lu-edge-raised); border-radius: var(--lu-radius-tile); color: var(--lu-accent); background: transparent; font: 600 var(--lu-type-label) var(--lu-font); text-align: center; cursor: pointer; }
    .more-tile:is(:active, [data-pressed]):not(:disabled) { background: var(--lu-material-press-wash); }
    .more-tile:disabled { color: var(--lu-ink-3); cursor: progress; }
    @media (hover: hover) and (pointer: fine) { .item:hover kestrel-lazy-image { filter: brightness(1.06); } }
  `];

  render() {
    return html`<ul role="list">
      ${this.items.map((item) => html`<li><button class="item" type="button" aria-label=${item.label} @pointerdown=${() => this._emit("warm", item.id)} @click=${() => this._emit("select", item.id)}>
        <span class="frame">
          <kestrel-lazy-image .src=${item.image} alt="" wide></kestrel-lazy-image>
          ${item.play ? html`<span class="glyph-wrap"><span class="glyph"><ha-icon .icon=${"mdi:play"} aria-hidden="true"></ha-icon></span></span>` : item.badge ? html`<span class="badge">${item.badgeIcon ? html`<ha-icon .icon=${item.badgeIcon} aria-hidden="true"></ha-icon>` : nothing}${item.badge}</span>` : nothing}
        </span>
        <span class="title">${item.title}</span>
        ${item.caption ? html`<span class="caption">${item.caption}</span>` : nothing}
      </button></li>`)}
      ${this.more ? html`<li class="more"><button class="more-tile" type="button" ?disabled=${this.loading} @click=${() => this.dispatchEvent(new CustomEvent("more"))}>${this.loading ? "Loading…" : this.moreLabel}</button></li>` : nothing}
    </ul>`;
  }
}

customElements.define("kestrel-media-rail", KestrelMediaRail);

declare global { interface HTMLElementTagNameMap { "kestrel-media-rail": KestrelMediaRail; } }
