import { BASE_CSS } from "lucent-ha";
import { LitElement, css, html, nothing } from "lit";
import { clipCount, confirmQuestion } from "../clips.ts";

/** The step before any clip is deleted: says how many clips go, what is kept, and has a button that does it and one that does not.
 * Used by the settings sheet (many clips) and a visit page (one). Fires `confirm` and `cancel`; the owner does the deleting and sets `busy` / `error`. */
export class KestrelClipConfirm extends LitElement {
  static properties = {
    count: { type: Number },
    bytes: { attribute: false },
    busy: { type: Boolean },
    error: { type: String },
  };

  declare count: number;
  /** How much space they take, or null when that is not known (one visit's clip). */
  declare bytes: number | null;
  declare busy: boolean;
  declare error: string;

  constructor() {
    super();
    this.count = 0;
    this.bytes = null;
    this.busy = false;
    this.error = "";
  }

  protected firstUpdated(): void {
    // The safe answer has the focus, so Enter or Space never deletes by accident.
    this.renderRoot.querySelector<HTMLElement>(".keep")?.focus({ preventScroll: true });
  }

  private _say(name: "confirm" | "cancel"): void {
    this.dispatchEvent(new CustomEvent(name));
  }

  static styles = [BASE_CSS, css`
    :host { display: block; }
    p { margin: 0; }
    .confirm { display: grid; gap: var(--lu-space-3); padding: var(--lu-space-4); border: 1px solid var(--lu-edge); border-radius: var(--lu-radius-tile); background: var(--lu-tile); }
    .ask { font-size: var(--lu-type-body); font-weight: 600; }
    .about { color: var(--lu-ink-2); font-size: var(--lu-type-label); }
    .busy { color: var(--lu-ink-2); font-size: var(--lu-type-label); }
    .problem { display: flex; align-items: flex-start; gap: var(--lu-space-2); color: var(--lu-danger); font-size: var(--lu-type-label); }
    .problem ha-icon { flex: none; --mdc-icon-size: 20px; }
    .buttons { display: flex; flex-wrap: wrap; gap: var(--lu-space-2); }
  `];

  render() {
    const { question, about } = confirmQuestion(this.count, this.bytes);
    return html`<div class="confirm" role="group" aria-label="Confirm deleting clips">
      <p class="ask">${question}</p>
      <p class="about">${about}</p>
      ${this.busy ? html`<p class="busy" role="status">Deleting ${clipCount(this.count)}…</p>` : nothing}
      ${this.error ? html`<p class="problem" role="alert"><ha-icon .icon=${"mdi:alert-circle-outline"}></ha-icon><span>${this.error} You can try again.</span></p>` : nothing}
      <div class="buttons">
        <kestrel-lu-button kind="danger" icon="mdi:delete-outline" .label=${`Delete ${clipCount(this.count)}`} ?loading=${this.busy} @click=${() => this._say("confirm")}></kestrel-lu-button>
        <kestrel-lu-button class="keep" kind="secondary" label="Keep them" ?disabled=${this.busy} @click=${() => this._say("cancel")}></kestrel-lu-button>
      </div>
    </div>`;
  }
}

customElements.define("kestrel-clip-confirm", KestrelClipConfirm);

declare global { interface HTMLElementTagNameMap { "kestrel-clip-confirm": KestrelClipConfirm; } }
