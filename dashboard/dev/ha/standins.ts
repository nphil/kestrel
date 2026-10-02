/* Copied from lucent-ha dev/ha-standins.ts (MIT, same owner) and trimmed for the Kestrel harness. */
/** The few Home Assistant elements the toolkit relies on being there, small and honest:
 *   <ha-icon icon="mdi:camera">  how the toolkit draws `mdi:` icons. Sized ONLY by `--mdc-icon-size` (24px), like the real one; its
 *                                host is inline, so width/height set on it do nothing (they do nothing in Home Assistant either).
 *   <ha-svg-icon .path=...>      the inline-flex box inside it.
 *   <ha-card>                    surface = `--ha-card-background` / `--card-background-color`, `backdrop-filter: var(--ha-card-backdrop-filter)`,
 *                                shadow, border and radius from the `--ha-card-*` variables. In glass themes the backdrop filter is real, so
 *                                a `position: fixed` element inside a card is positioned against the card, as it is in Home Assistant.
 * Icon artwork comes from dev/mdi-subset.ts; an unknown name draws a dashed box and warns once. */
import { LitElement, css, html, nothing, svg, type PropertyValues, type TemplateResult } from "lit";
import { MDI_PATHS } from "./mdi-subset.ts";

export class HaSvgIcon extends LitElement {
  static properties = { path: {}, viewBox: { attribute: false } };
  declare path: string | undefined;
  declare viewBox: string | undefined;

  protected render(): TemplateResult {
    return html`<svg viewBox=${this.viewBox || "0 0 24 24"} preserveAspectRatio="xMidYMid meet" focusable="false" role="img" aria-hidden="true">${this.path ? svg`<path d=${this.path}></path>` : nothing}</svg>`;
  }

  static styles = css`
    :host {
      display: var(--ha-icon-display, inline-flex);
      align-items: center;
      justify-content: center;
      position: relative;
      vertical-align: middle;
      fill: var(--icon-primary-color, currentcolor);
      width: var(--mdc-icon-size, 24px);
      height: var(--mdc-icon-size, 24px);
    }
    svg { width: 100%; height: 100%; pointer-events: none; display: block; }
  `;
}

const warned = new Set<string>();

export class HaIcon extends LitElement {
  static properties = { icon: {} };
  declare icon: string | undefined;

  /** The path for `mdi:name`, or undefined when the harness does not carry that icon (or it is not an mdi icon). */
  private get path(): string | undefined {
    const name = this.icon?.startsWith("mdi:") ? this.icon.slice(4) : undefined;
    return name === undefined ? undefined : MDI_PATHS[name];
  }

  protected willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("icon") && this.icon && this.path === undefined && !warned.has(this.icon)) {
      warned.add(this.icon);
      console.warn(`ha-icon stand-in: "${this.icon}" is not in dev/ha/mdi-subset.ts`);
    }
  }

  protected render(): TemplateResult | typeof nothing {
    if (!this.icon) return nothing;
    return html`<ha-svg-icon .path=${this.path ?? MDI_PATHS["help-circle-outline"]} style=${this.path === undefined ? "opacity: .45" : nothing}></ha-svg-icon>`;
  }
}

export class HaCard extends LitElement {
  static properties = { header: {}, raised: { type: Boolean, reflect: true } };
  declare header: string | undefined;
  declare raised: boolean;

  constructor() {
    super();
    this.raised = false;
  }

  protected render(): TemplateResult {
    return html`${this.header ? html`<h1 class="card-header">${this.header}</h1>` : nothing}<slot></slot>`;
  }

  static styles = css`
    :host {
      background: var(--ha-card-background, var(--card-background-color, white));
      -webkit-backdrop-filter: var(--ha-card-backdrop-filter, none);
      backdrop-filter: var(--ha-card-backdrop-filter, none);
      box-shadow: var(--ha-card-box-shadow, none);
      box-sizing: border-box;
      border-radius: var(--ha-card-border-radius, var(--ha-border-radius-lg));
      border-width: var(--ha-card-border-width, 1px);
      border-style: solid;
      border-color: var(--ha-card-border-color, var(--divider-color, #e0e0e0));
      color: var(--primary-text-color);
      display: block;
      position: relative;
    }
    :host([raised]) { border: none; box-shadow: var(--ha-card-box-shadow, 0 2px 1px -1px rgba(0, 0, 0, 0.2), 0 1px 1px 0 rgba(0, 0, 0, 0.14), 0 1px 3px 0 rgba(0, 0, 0, 0.12)); }
    .card-header {
      margin: 0;
      padding: var(--ha-space-3) var(--ha-space-4) var(--ha-space-4);
      color: var(--ha-card-header-color, var(--primary-text-color));
      font-family: var(--ha-card-header-font-family, inherit);
      font-size: var(--ha-card-header-font-size, var(--ha-font-size-2xl));
      font-weight: var(--ha-font-weight-normal);
      line-height: var(--ha-line-height-expanded);
      letter-spacing: -0.012em;
    }
  `;
}
