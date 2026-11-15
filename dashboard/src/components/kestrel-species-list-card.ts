import { BASE_CSS, navigate } from "lucent-ha";
import { css, html, nothing } from "lit";
import { api, speciesArray, speciesPicture } from "../api.ts";
import { filterOf, listConfig, listEvidence, listLast, listRows, listTitle, speciesRoute, type ListCardConfig, type ListConfig } from "../highlights.ts";
import { speciesKey } from "../period.ts";
import type { Species } from "../types.ts";
import { HEARD_HERO_CSS, heardHero } from "../ui/heard-hero.ts";
import { KIND } from "../vocab.ts";
import { emptyWildlife } from "../wildlife.ts";
import { KestrelDataCard, listCard } from "./kestrel-card.ts";

/** The species of one stretch of time as a short list, the busiest first: a photo, the name, when it last turned up, and how many videos and recordings it has. A tap on a row opens
 * that species in the Kestrel panel.
 *
 *     type: custom:kestrel-species-list-card
 *     period: week            # today | week | month | all
 *     limit: 6                # 1 to 24 rows
 *     kinds: both             # both | seen | heard */
export class KestrelSpeciesListCard extends KestrelDataCard<Species[]> {
  private _config: ListConfig = listConfig(undefined);

  setConfig(config: ListCardConfig): void {
    this._config = listConfig(config);
    const { period } = this._config;
    // The Wildlife list in the panel asks the same question under the same name: the two share one answer.
    this.ask(speciesKey(period), async (hass) => speciesArray(await api.species(hass, period)));
    this.requestUpdate();
  }

  /** Home Assistant's old layouts count in 50 px steps: a title and a row of about 64 px each. */
  getCardSize(): number { return Math.ceil((44 + this._config.limit * 64) / 50); }

  getGridOptions() { return { columns: 6, rows: "auto", min_columns: 3 }; }

  static getStubConfig(): ListCardConfig { return { type: "custom:kestrel-species-list-card", period: "week", limit: 6, kinds: "both" }; }

  static getConfigElement(): HTMLElement { return document.createElement("kestrel-species-list-card-editor"); }

  private _open(event: MouseEvent, path: string): void {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; // a new tab, a new window: the browser's own
    event.preventDefault();
    navigate(this, path);
  }

  static styles = [BASE_CSS, HEARD_HERO_CSS, css`
    :host { display: block; }
    .title { margin: 0; padding: var(--lu-space-4) var(--lu-space-4) var(--lu-space-1); color: var(--lu-ink-2); font-size: var(--lu-type-label); font-weight: 600; }
    .rows { padding: 0 var(--lu-space-2) var(--lu-space-2); }
    .thumb { position: relative; width: 56px; overflow: hidden; border-radius: var(--lu-radius-tile); }
    .evidence { display: flex; align-items: center; gap: var(--lu-space-2); }
  `];

  private _row(species: Species, config: ListConfig) {
    const picture = speciesPicture(species);
    const icon = KIND[species.heard ? "heard" : "seen"].icon;
    const path = speciesRoute(species.species);
    return html`<kestrel-lu-row heading=${species.species} detail=${listLast(species, config.kinds) ?? ""} href=${path} @click=${(event: MouseEvent) => this._open(event, path)}>
      <div slot="leading" class="thumb" title=${picture.isReference ? "Reference photo" : nothing}>
        <kestrel-lu-image .src=${picture.url ?? ""} ratio="1" alt="">${heardHero(icon, "fallback")}</kestrel-lu-image>
        ${picture.url ? nothing : heardHero(icon)}
      </div>
      <span slot="trailing" class="evidence">
        ${listEvidence(species, config).map(({ kind, count }) => html`<kestrel-lu-chip kind="evidence" icon=${KIND[kind].icon} label=${KIND[kind].word} .count=${Math.min(count, 999)}></kestrel-lu-chip>`)}
      </span>
    </kestrel-lu-row>`;
  }

  private _list(species: Species[]) {
    const config = this._config;
    const rows = listRows(species, config);
    return html`
      <h2 class="title">${listTitle(config.period)}</h2>
      ${rows.length
        ? html`<div class="rows">${rows.map((each) => this._row(each, config))}</div>`
        : html`<kestrel-lu-state kind="empty" compact heading=${emptyWildlife(config.period, filterOf(config.kinds)).heading}></kestrel-lu-state>`}`;
  }

  protected render() {
    const loading = html`<kestrel-lu-state kind="loading" variant="rows" count=${Math.min(this._config.limit, 4)} heading="Loading wildlife"></kestrel-lu-state>`;
    return this.renderCard(this.renderAnswer((species) => this._list(species), loading));
  }
}

customElements.define("kestrel-species-list-card", KestrelSpeciesListCard);
listCard("kestrel-species-list-card", "Kestrel species list", "The species of today, the week or the month, the busiest first.");

declare global { interface HTMLElementTagNameMap { "kestrel-species-list-card": KestrelSpeciesListCard; } }
