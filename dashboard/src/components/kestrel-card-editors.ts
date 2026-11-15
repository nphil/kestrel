import { emit } from "lucent-ha";
import { LitElement, css, html } from "lit";
import { HIGHLIGHT_SHOWS, KIND_CHOICES, LIST_LIMIT, headline, highlightConfig, highlightYaml, listConfig, listYaml, type HighlightCardConfig, type KindChoice, type ListCardConfig } from "../highlights.ts";
import { PERIODS, PERIOD_LABEL } from "../period.ts";
import type { HomeAssistant } from "../types.ts";

/** What Home Assistant's form builder needs to know about one setting. */
interface Field { name: string; selector: Record<string, unknown> }

const KIND_CHOICE_LABEL: Record<KindChoice, string> = { both: "Seen and heard", seen: "Seen on camera", heard: "Heard" };

const dropdown = (options: ReadonlyArray<{ value: string; label: string }>): Field["selector"] => ({ select: { mode: "dropdown", options } });
const periodField: Field = { name: "period", selector: dropdown(PERIODS.map((value) => ({ value, label: PERIOD_LABEL[value] }))) };
const kindsField: Field = { name: "kinds", selector: dropdown(KIND_CHOICES.map((value) => ({ value, label: KIND_CHOICE_LABEL[value] }))) };
const toggle = (name: string): Field => ({ name, selector: { boolean: {} } });

/** The part both card editors share. Home Assistant gives an editor the card's settings (`setConfig`) and listens for `config-changed`; the form itself is Home Assistant's own,
 * so the editor looks like every other card's. Every setting is written out, with what the card does when it is not. */
abstract class KestrelCardEditor<Config extends { type: string }> extends LitElement {
  static properties = { hass: { attribute: false }, _config: { state: true } };

  declare hass: HomeAssistant | undefined;
  declare _config: Config | undefined;

  setConfig(config: Config): void { this._config = config; }

  protected abstract schema(config: Config): readonly Field[];

  protected abstract values(config: Config): Record<string, unknown>;

  protected abstract readonly labels: Record<string, string>;

  private _label = (field: Field): string => this.labels[field.name] ?? field.name;

  private _changed = (event: Event): void => {
    event.stopPropagation();
    const config = this._config;
    if (!config || !(event instanceof CustomEvent)) return;
    emit(this, "config-changed", { config: { ...event.detail.value, type: config.type } });
  };

  static styles = css`:host { display: block; }`;

  protected render() {
    const config = this._config;
    if (!config) return html``;
    return html`<ha-form .hass=${this.hass} .data=${this.values(config)} .schema=${this.schema(config)} .computeLabel=${this._label} @value-changed=${this._changed}></ha-form>`;
  }
}

export class KestrelHighlightCardEditor extends KestrelCardEditor<HighlightCardConfig> {
  protected readonly labels = { show: "Show", period: "Period", kinds: "Count", show_name: "Show the name", show_scientific_name: "Show the scientific name", show_time: "Show when", show_count: "Show how many visits" };

  protected schema(config: HighlightCardConfig): readonly Field[] {
    const { kinds } = highlightConfig(config);
    return [
      { name: "show", selector: dropdown(HIGHLIGHT_SHOWS.map((value) => ({ value, label: headline(value, kinds) }))) },
      periodField,
      kindsField,
      toggle("show_name"),
      toggle("show_scientific_name"),
      toggle("show_time"),
      toggle("show_count"),
    ];
  }

  protected values(config: HighlightCardConfig): Record<string, unknown> { return highlightYaml(highlightConfig(config)); }
}

export class KestrelSpeciesListCardEditor extends KestrelCardEditor<ListCardConfig> {
  protected readonly labels = { period: "Period", limit: "Number of species", kinds: "Count" };

  protected schema(): readonly Field[] {
    return [periodField, { name: "limit", selector: { number: { min: LIST_LIMIT.min, max: LIST_LIMIT.max, step: 1, mode: "box" } } }, kindsField];
  }

  protected values(config: ListCardConfig): Record<string, unknown> { return listYaml(listConfig(config)); }
}

customElements.define("kestrel-highlight-card-editor", KestrelHighlightCardEditor);
customElements.define("kestrel-species-list-card-editor", KestrelSpeciesListCardEditor);

declare global {
  interface HTMLElementTagNameMap {
    "kestrel-highlight-card-editor": KestrelHighlightCardEditor;
    "kestrel-species-list-card-editor": KestrelSpeciesListCardEditor;
  }
}
