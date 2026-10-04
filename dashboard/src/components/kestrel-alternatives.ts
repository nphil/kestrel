import { BASE_CSS } from "lucent-ha";
import { LitElement, css, html, nothing } from "lit";
import type { AudioAlternative, HomeAssistant } from "../types.ts";
import { percentSure } from "../vocab.ts";
import "./kestrel-reference-sound.ts";

/** "Could also be": the species a second listen to the recording hears more strongly than the one the detector named, each with how sure it is and
 * the existing "Play reference" button, so a person can hear what it sounds like before choosing. Choosing one fires `pick` ({ species }); the host
 * corrects the visit exactly as the "What was it?" picker does. Used on a heard visit and at the top of that picker. Draws nothing without species. */
export class KestrelAlternatives extends LitElement {
  static properties = {
    // Only read when a "Play reference" button is pressed, so a new one for every change in the house needs no redraw.
    hass: { attribute: false, hasChanged: () => false },
    alternatives: { attribute: false },
    disabled: { type: Boolean },
  };

  declare hass: HomeAssistant | undefined;
  declare alternatives: AudioAlternative[];
  /** A correction is being saved: nothing can be chosen until it lands. */
  declare disabled: boolean;

  constructor() {
    super();
    this.alternatives = [];
    this.disabled = false;
  }

  private _pick(species: string): void {
    if (this.disabled) return;
    this.dispatchEvent(new CustomEvent<{ species: string }>("pick", { detail: { species }, bubbles: true, composed: true }));
  }

  static styles = [BASE_CSS, css`
    :host { display: block; grid-column: 1 / -1; min-width: 0; }
    h3, p { margin: 0; }
    h3 { font-size: var(--lu-type-label); font-weight: 600; }
    .about { margin-top: var(--lu-space-1); color: var(--lu-ink-2); font-size: var(--lu-type-caption); line-height: 1.4; }
    ul { display: grid; margin: var(--lu-space-2) 0 0; padding: 0; list-style: none; }
    li { min-width: 0; }
    li + li { margin-top: var(--lu-space-2); }
    .score { color: var(--lu-ink-2); font-size: var(--lu-type-label); font-variant-numeric: tabular-nums; }
    /* The reference button belongs to the row above it: no rule between them, and it lines up with the row's text. */
    kestrel-reference-sound { padding-top: 0; padding-left: var(--lu-space-4); border-top: 0; }
  `];

  render() {
    const items = Array.isArray(this.alternatives) ? this.alternatives : [];
    if (!items.length) return nothing;
    return html`<section aria-label="Could also be">
      <h3>Could also be</h3>
      <p class="about">A second listen to the recording thinks these may fit better.</p>
      <ul>
        ${items.map((item) => html`<li>
          <kestrel-lu-row interactive chevron ?disabled=${this.disabled} .heading=${item.species} @click=${() => this._pick(item.species)}>
            <span slot="trailing" class="score">${percentSure(item.score)}</span>
          </kestrel-lu-row>
          <kestrel-reference-sound compact no-hint .hass=${this.hass} .species=${item.species}></kestrel-reference-sound>
        </li>`)}
      </ul>
    </section>`;
  }
}

customElements.define("kestrel-alternatives", KestrelAlternatives);

declare global { interface HTMLElementTagNameMap { "kestrel-alternatives": KestrelAlternatives; } }
