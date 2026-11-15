/* `?cards=1`: the page at /kestrel/cards that shows the two Kestrel cards laid out the way a dashboard lays them out, and their editors with a live preview.
 * Home Assistant builds a card with createElement, `setConfig(config)` and then `hass`; this does the same. A tap on a card goes to the panel: every other address
 * under /kestrel shows the real panel here, and back returns to this page. */

interface CardElement extends HTMLElement {
  hass?: unknown;
  setConfig(config: Record<string, unknown>): void;
  getCardSize?(): number;
  getGridOptions?(): { columns?: number | "full" };
}
interface CardClass { getStubConfig(): Record<string, unknown>; getConfigElement(): HTMLElement | Promise<HTMLElement> }

/** `columns` overrides what the card asks for (of the dashboard's 12); `width` squeezes the card to that many pixels. */
interface Demo { tag: string; note: string; config: Record<string, unknown>; columns?: number; width?: number }

const HIGHLIGHTS: Demo[] = [
  { tag: "kestrel-highlight-card", note: "Latest, 7 days (the defaults)", config: {} },
  { tag: "kestrel-highlight-card", note: "Most frequent, today, name only", config: { show: "most", period: "today", show_time: false, show_count: false } },
  { tag: "kestrel-highlight-card", note: "Least heard, 30 days, with the scientific name", config: { show: "least", period: "month", kinds: "heard", show_scientific_name: true } },
  { tag: "kestrel-highlight-card", note: "240 pixels wide", config: { show: "latest", kinds: "seen" }, width: 240 },
];
const LISTS: Demo[] = [
  { tag: "kestrel-species-list-card", note: "7 days, 6 species (the defaults)", config: {} },
  { tag: "kestrel-species-list-card", note: "Today, 3 species, seen on camera", config: { period: "today", limit: 3, kinds: "seen" } },
  { tag: "kestrel-species-list-card", note: "All time, 8 species, heard", config: { period: "all", limit: 8, kinds: "heard" } },
];

const STYLE = `
kestrel-cards-page { display: block; padding: 16px; box-sizing: border-box; max-width: 1280px; margin: 0 auto; color: var(--primary-text-color); font-family: var(--ha-font-family-body, system-ui, sans-serif); }
kestrel-cards-page h2 { margin: 24px 0 8px; font-size: 14px; font-weight: 500; color: var(--secondary-text-color); }
kestrel-cards-page .grid { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: 8px; align-items: start; }
kestrel-cards-page .cell { grid-column: span var(--columns, 6); min-width: 0; }
kestrel-cards-page small { display: block; margin: 0 0 4px; color: var(--secondary-text-color); font-size: 11px; }
kestrel-cards-page .bench { grid-column: 1 / -1; display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; }
kestrel-cards-page .bench .cell { grid-column: auto; }
kestrel-cards-page .editor { padding: 12px; border: 1px solid var(--divider-color); border-radius: 12px; }
kestrel-cards-page pre { margin: 8px 0 0; font-size: 11px; white-space: pre-wrap; color: var(--secondary-text-color); }
@media (max-width: 700px) { kestrel-cards-page .cell { grid-column: 1 / -1; } }
@media (min-width: 701px) { kestrel-cards-page .bench { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); align-items: start; } }
`;

export class KestrelCardsPage extends HTMLElement {
  narrow = false;
  private _hass: unknown;
  private _route: { prefix: string; path: string } | undefined;
  private _panelConfig: unknown;
  private _page: HTMLElement | undefined;
  private _panel: HTMLElement | undefined;
  private _elements: Array<{ hass?: unknown }> = [];

  get hass(): unknown { return this._hass; }
  set hass(value: unknown) { this._hass = value; this._sync(); }
  get route(): { prefix: string; path: string } | undefined { return this._route; }
  set route(value: { prefix: string; path: string } | undefined) { this._route = value; this._sync(); }
  get panel(): unknown { return this._panelConfig; }
  set panel(value: unknown) { this._panelConfig = value; this._sync(); }

  private _sync(): void {
    if (this._route?.path === "/cards") {
      this._panel?.remove();
      this._panel = undefined;
      if (!this._page) { this._page = document.createElement("div"); this.append(this._page); void this._build(this._page); }
      for (const element of this._elements) element.hass = this._hass;
      return;
    }
    this._page?.remove();
    this._page = undefined;
    this._elements = [];
    if (!this._panel) { this._panel = document.createElement("kestrel-panel"); this.append(this._panel); }
    Object.assign(this._panel, { hass: this._hass, narrow: this.narrow, route: this._route, panel: this._panelConfig });
  }

  private _card(demo: Demo, parent: HTMLElement): CardElement {
    const card = document.createElement(demo.tag) as CardElement;
    card.setConfig({ type: `custom:${demo.tag}`, ...demo.config });
    card.hass = this._hass;
    this._elements.push(card);
    const cell = document.createElement("div");
    cell.className = "cell";
    const grid = card.getGridOptions?.();
    cell.style.setProperty("--columns", String(demo.columns ?? (typeof grid?.columns === "number" ? grid.columns : 6)));
    if (demo.width) cell.style.width = `${demo.width}px`;
    cell.dataset.cardSize = String(card.getCardSize?.() ?? "");
    const note = document.createElement("small");
    note.textContent = demo.note;
    cell.append(note, card);
    parent.append(cell);
    return card;
  }

  /** The editor of a card type next to a card that follows what the editor writes. */
  private async _workbench(tag: Demo["tag"], parent: HTMLElement): Promise<void> {
    const kind = customElements.get(tag) as unknown as CardClass;
    const stub = kind.getStubConfig();
    const editor = await kind.getConfigElement() as HTMLElement & { hass?: unknown; setConfig(config: Record<string, unknown>): void };
    const box = document.createElement("div");
    box.className = "bench";
    const left = document.createElement("div");
    left.className = "editor";
    const written = document.createElement("pre");
    const card = this._card({ tag, note: "Preview", config: stub }, box);
    editor.hass = this._hass;
    editor.setConfig(stub);
    written.textContent = JSON.stringify(stub);
    editor.addEventListener("config-changed", (event) => {
      const config = (event as CustomEvent<{ config: Record<string, unknown> }>).detail.config;
      editor.setConfig(config);
      card.setConfig(config);
      written.textContent = JSON.stringify(config);
    });
    this._elements.push(editor);
    left.append(editor, written);
    box.prepend(left);
    parent.append(box);
  }

  private async _build(page: HTMLElement): Promise<void> {
    if (!document.head.querySelector("style[data-cards-page]")) {
      const style = document.createElement("style");
      style.dataset.cardsPage = "";
      style.textContent = STYLE;
      document.head.append(style);
    }
    const section = (heading: string): HTMLElement => {
      const title = document.createElement("h2");
      title.textContent = heading;
      const grid = document.createElement("div");
      grid.className = "grid";
      page.append(title, grid);
      return grid;
    };
    const highlights = section("Highlight card");
    for (const demo of HIGHLIGHTS) this._card(demo, highlights);
    const lists = section("Species list card");
    for (const demo of LISTS) this._card(demo, lists);
    const editors = section("Editors (change a setting: the card beside it follows)");
    await this._workbench("kestrel-highlight-card", editors);
    await this._workbench("kestrel-species-list-card", editors);
  }
}

if (!customElements.get("kestrel-cards-page")) customElements.define("kestrel-cards-page", KestrelCardsPage);
