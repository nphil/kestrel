import { LitElement, css, html, nothing } from "lit";
import { FOCUS_CSS } from "../styles/tokens.ts";

export interface SegmentOption {
  value: string;
  label: string;
  /** Icon drawn beside the count. */
  icon?: string;
  count?: number;
}

/** Lucent segmented control: an exclusive choice between 2 and 5 options in a recessed tray.
 * The selected option is the raised one and carries a small accent mark; keyboard focus is a separate
 * landing light. It is a controlled radio group: set `value`, listen for `change` (detail: { value }). */
export class KestrelSegmented extends LitElement {
  static properties = {
    options: { attribute: false },
    value: { type: String },
    label: { type: String },
  };

  declare options: SegmentOption[];
  declare value: string;
  declare label: string;

  constructor() {
    super();
    this.options = [];
    this.value = "";
    this.label = "";
  }

  private _select(value: string): void {
    if (value !== this.value) this.dispatchEvent(new CustomEvent("change", { detail: { value } }));
  }

  /** Arrow keys move through the options (selection follows focus, as in a native radio group). */
  private _onKeydown(event: KeyboardEvent): void {
    const keys: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    const count = this.options.length;
    const current = this.options.findIndex((option) => option.value === this.value);
    let next = -1;
    if (event.key in keys) next = (current + keys[event.key] + count) % count;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = count - 1;
    if (next < 0) return;
    event.preventDefault();
    this.renderRoot.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
    this._select(this.options[next].value);
  }

  static styles = [FOCUS_CSS, css`
    /* The height is reserved up front, so the page below doesn't shift when the options render. */
    :host { display: block; min-width: 0; max-width: 480px; min-height: calc(var(--lu-row) + var(--lu-space-1) * 2 + 2px); }
    .tray { display: flex; gap: var(--lu-space-1); padding: var(--lu-space-1); border: 1px solid var(--lu-edge); border-radius: var(--lu-radius-control); background: var(--lu-material-well); }
    .segment { position: relative; display: grid; flex: 1 1 0; min-width: 0; min-height: var(--lu-row); align-content: center; justify-items: center; gap: 2px; padding: var(--lu-space-1) var(--lu-space-2); border: 1px solid transparent; border-radius: max(calc(var(--lu-radius-control) - 5px), 6px); color: var(--lu-ink-2); background: transparent; font: 500 var(--lu-type-label)/1.2 var(--lu-font); cursor: pointer; transition: background-color var(--lu-motion-label) var(--lu-ease); }
    .segment[aria-checked="true"] { color: var(--lu-ink); background: var(--lu-glass-raised); border-color: var(--lu-edge-raised); box-shadow: var(--lu-highlight-raised); font-weight: 600; }
    .segment[aria-checked="true"]::after { content: ""; position: absolute; top: var(--lu-space-2); right: var(--lu-space-2); width: 6px; height: 6px; border-radius: 50%; background: var(--lu-accent); }
    .segment:is(:active, [data-pressed]) { background-image: linear-gradient(var(--lu-material-press-wash), var(--lu-material-press-wash)); }
    @media (hover: hover) and (pointer: fine) { .segment[aria-checked="false"]:hover { background: var(--lu-material-hover-wash); } }
    .name { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .meta { display: inline-flex; align-items: center; gap: var(--lu-space-1); font-size: var(--lu-type-caption); font-variant-numeric: tabular-nums; }
    ha-icon { --mdc-icon-size: 14px; width: 14px; height: 14px; flex: none; }
  `];

  render() {
    return html`<div class="tray" role="radiogroup" aria-label=${this.label}>
      ${this.options.map((option) => {
        const selected = option.value === this.value;
        return html`<button type="button" role="radio" class="segment" aria-checked=${selected ? "true" : "false"} tabindex=${selected ? 0 : -1} @click=${() => this._select(option.value)} @keydown=${this._onKeydown}>
          <span class="name">${option.label}</span>
          <span class="meta">${option.icon ? html`<ha-icon .icon=${option.icon} aria-hidden="true"></ha-icon>` : nothing}<span>${option.count ?? nothing}</span></span>
        </button>`;
      })}
    </div>`;
  }
}

customElements.define("kestrel-segmented", KestrelSegmented);

declare global { interface HTMLElementTagNameMap { "kestrel-segmented": KestrelSegmented; } }
