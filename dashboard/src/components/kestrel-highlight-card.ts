import { BASE_CSS, navigate, renderIcon } from "lucent-ha";
import { css, html, nothing } from "lit";
import { api, speciesPicture } from "../api.ts";
import { highlightConfig, highlightEmpty, highlightFor, highlightRoute, highlightText, highlightsKey, readHighlights, type Highlight, type HighlightCardConfig, type HighlightConfig, type Highlights } from "../highlights.ts";
import { HEARD_HERO_CSS, heardHero } from "../ui/heard-hero.ts";
import { KIND } from "../vocab.ts";
import { KestrelDataCard, listCard } from "./kestrel-card.ts";

/** One thing about the wildlife, big enough to read from across a room: the newest visit, the species heard or seen the most, or the one the least, over today, 7 days, 30 days or
 * all time. A photo, the name, and when and how often; each of those can be switched off. A tap opens the visit (for the newest) or the species in the Kestrel panel.
 *
 *     type: custom:kestrel-highlight-card
 *     show: latest            # latest | most | least
 *     period: week            # today | week | month | all
 *     kinds: both             # both | seen | heard
 *     show_name: true
 *     show_scientific_name: false
 *     show_time: true
 *     show_count: true */
export class KestrelHighlightCard extends KestrelDataCard<Highlights> {
  private _config: HighlightConfig = highlightConfig(undefined);

  setConfig(config: HighlightCardConfig): void {
    this._config = highlightConfig(config);
    const { period, kinds } = this._config;
    this.ask(highlightsKey(period, kinds), async (hass) => readHighlights(await api.highlights(hass, period, kinds)));
    this.requestUpdate();
  }

  getCardSize(): number { return 3; }

  getGridOptions() { return { columns: 6, rows: "auto", min_columns: 3 }; }

  static getStubConfig(): HighlightCardConfig { return { type: "custom:kestrel-highlight-card", show: "latest", period: "week", kinds: "both" }; }

  static getConfigElement(): HTMLElement { return document.createElement("kestrel-highlight-card-editor"); }

  private _open(event: MouseEvent, path: string): void {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; // a new tab, a new window: the browser's own
    event.preventDefault();
    navigate(this, path);
  }

  static styles = [BASE_CSS, HEARD_HERO_CSS, css`
    :host { display: block; container-type: inline-size; }
    .highlight { display: grid; grid-template-columns: clamp(72px, 26cqi, 128px) minmax(0, 1fr); align-items: center; gap: var(--lu-space-4); padding: var(--lu-space-4); color: var(--lu-ink); text-decoration: none; -webkit-tap-highlight-color: transparent; transition: background-color var(--lu-motion-label) var(--lu-ease); }
    .highlight:is(:active, [data-pressed]) { background: var(--lu-material-press-wash); transition: none; }
    @media (hover: hover) and (pointer: fine) { .highlight:hover { background: var(--lu-material-hover-wash); } }
    .photo { display: grid; gap: var(--lu-space-1); min-width: 0; }
    .frame { position: relative; }
    .text { display: grid; gap: var(--lu-space-1); min-width: 0; }
    .eyebrow { color: var(--lu-ink-3); font-size: var(--lu-type-caption); font-weight: 600; letter-spacing: .02em; }
    .name { overflow-wrap: anywhere; font-size: var(--lu-type-title); font-weight: 620; letter-spacing: -.012em; line-height: 1.2; }
    .latin { overflow-wrap: anywhere; color: var(--lu-ink-2); font-size: var(--lu-type-label); font-style: italic; }
    .meta { display: flex; align-items: center; gap: var(--lu-space-2); min-width: 0; color: var(--lu-ink-2); font-size: var(--lu-type-label); }
    .meta .icon { --lu-icon: 16px; color: var(--lu-ink-3); }
    .meta span { min-width: 0; overflow-wrap: anywhere; }
    .caption { text-align: center; }
    @container (max-width: 259px) { .highlight { grid-template-columns: minmax(0, 1fr); } .photo { max-width: 128px; } }
    @media (prefers-reduced-motion: reduce) { .highlight { transition: none; } }
  `];

  private _picture(item: Highlight) {
    const picture = speciesPicture(item);
    const icon = KIND[item.kind].icon;
    return html`<div class="photo">
      <div class="frame">
        <kestrel-lu-image .src=${picture.url ?? ""} ratio="1" alt="">${heardHero(icon, "fallback")}</kestrel-lu-image>
        ${picture.url ? nothing : heardHero(icon)}
      </div>
      ${picture.isReference ? html`<span class="caption">Reference photo</span>` : nothing}
    </div>`;
  }

  private _highlight(highlights: Highlights) {
    const config = this._config;
    const item = highlightFor(highlights, config.show);
    if (!item) return html`<kestrel-lu-state kind="empty" compact heading=${highlightEmpty(config)}></kestrel-lu-state>`;
    const words = highlightText(item, config);
    const path = highlightRoute(item, config.show);
    const meta = [words.time, words.count].filter(Boolean).join(" · ");
    return html`<a class="highlight" href=${path} aria-label=${words.label} @click=${(event: MouseEvent) => this._open(event, path)}>
      ${this._picture(item)}
      <div class="text">
        <span class="eyebrow">${words.eyebrow}</span>
        ${words.name ? html`<span class="name">${words.name}</span>` : nothing}
        ${words.scientific ? html`<span class="latin">${words.scientific}</span>` : nothing}
        ${meta ? html`<div class="meta">${words.time ? renderIcon(KIND[item.kind].icon) : nothing}<span>${meta}</span></div>` : nothing}
      </div>
    </a>`;
  }

  protected render() {
    return this.renderCard(this.renderAnswer((highlights) => this._highlight(highlights), html`<kestrel-lu-state kind="loading" variant="rows" count="1" heading="Loading wildlife"></kestrel-lu-state>`));
  }
}

customElements.define("kestrel-highlight-card", KestrelHighlightCard);
listCard("kestrel-highlight-card", "Kestrel highlight", "The newest visit, or the species heard or seen the most or the least.");

declare global { interface HTMLElementTagNameMap { "kestrel-highlight-card": KestrelHighlightCard; } }
