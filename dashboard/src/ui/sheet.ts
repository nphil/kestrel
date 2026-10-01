import { LitElement, css, html, nothing } from "lit";
import { BASE_CSS, CONTROLS_CSS } from "../styles/tokens.ts";

/** Pixels the sheet must be dragged down, or flicked at, before it counts as dismissed. */
const DISMISS_DISTANCE = 96;
const DISMISS_SPEED = 0.6;

function deepActiveElement(): HTMLElement | null {
  let active: Element | null = document.activeElement;
  while (active instanceof HTMLElement && active.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active instanceof HTMLElement ? active : null;
}

/** Lucent modal sheet. Lives in the browser's top layer (a native `<dialog>`), so it always sits over the
 * whole screen, whatever the panel around it clips or transforms; the page behind it is inert and Tab stays
 * inside. It rises from the bottom on narrow panels (where the handle or header can be dragged down to
 * dismiss it) and floats centred on wide ones. Esc, the scrim and the close button all ask the owner to
 * close it with a `close` event; the owner removes the element. Focus goes back to whatever opened it.
 *
 * Needs the host's `--lu-*` tokens; renders its content in the default slot. */
export class KestrelSheet extends LitElement {
  static properties = {
    heading: { type: String },
    subheading: { type: String },
    closeLabel: { type: String, attribute: "close-label" },
    _leaving: { state: true },
  };

  declare heading: string;
  declare subheading: string;
  declare closeLabel: string;
  declare _leaving: boolean;

  private _opener: HTMLElement | null = null;
  private _timer = 0;
  private _scrimDown = false;
  private _drag: { id: number; startY: number; startTime: number; offset: number } | null = null;

  constructor() {
    super();
    this.heading = "";
    this.subheading = "";
    this.closeLabel = "Close";
    this._leaving = false;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this._opener = deepActiveElement();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.clearTimeout(this._timer);
    const opener = this._opener;
    this._opener = null;
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  }

  protected firstUpdated(): void {
    const dialog = this.renderRoot.querySelector("dialog");
    if (dialog && !dialog.open) dialog.showModal();
  }

  /** Lets the exit motion play, then asks the owner to remove the sheet. */
  close(): void {
    if (this._leaving) return;
    this._leaving = true;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    this._timer = window.setTimeout(() => this.dispatchEvent(new CustomEvent("close")), reduce ? 0 : 150);
  }

  private _onCancel(event: Event): void {
    event.preventDefault();
    this.close();
  }

  /** Only a press that both started and ended on the scrim dismisses; dragging out of the sheet doesn't. */
  private _onScrimDown(event: Event): void { this._scrimDown = event.target === event.currentTarget; }

  private _onScrim(event: Event): void {
    if (this._scrimDown && event.target === event.currentTarget) this.close();
    this._scrimDown = false;
  }

  /** The scrim isn't scrollable; keep the wheel from moving the page behind it. */
  private _onWheel(event: WheelEvent): void {
    if (event.target === event.currentTarget) event.preventDefault();
  }

  private get _sheet(): HTMLElement | null { return this.renderRoot.querySelector(".sheet"); }

  private _onDragStart(event: PointerEvent): void {
    const handle = this.renderRoot.querySelector<HTMLElement>(".handle");
    if (!handle || handle.offsetParent === null || event.button !== 0) return; // wide layout: nothing to drag
    if ((event.target as HTMLElement).closest(".close")) return;
    this._drag = { id: event.pointerId, startY: event.clientY, startTime: event.timeStamp, offset: 0 };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  private _onDragMove(event: PointerEvent): void {
    const drag = this._drag;
    const sheet = this._sheet;
    if (!drag || drag.id !== event.pointerId || !sheet) return;
    drag.offset = Math.max(0, event.clientY - drag.startY);
    sheet.style.transition = "none";
    sheet.style.transform = `translateY(${drag.offset}px)`;
  }

  private _onDragEnd(event: PointerEvent): void {
    const drag = this._drag;
    const sheet = this._sheet;
    if (!drag || drag.id !== event.pointerId || !sheet) return;
    this._drag = null;
    const speed = drag.offset / Math.max(1, event.timeStamp - drag.startTime);
    if (event.type === "pointerup" && (drag.offset > DISMISS_DISTANCE || (drag.offset > 24 && speed > DISMISS_SPEED))) {
      this.close();
      return;
    }
    sheet.style.transition = "";
    sheet.style.transform = "";
  }

  static styles = [BASE_CSS, CONTROLS_CSS, css`
    :host { display: contents; }
    h2, p { margin: 0; }
    dialog {
      position: fixed; inset: 0; width: 100%; height: 100%; max-width: none; max-height: none; margin: 0; padding: 0;
      overflow: hidden; border: 0; color: var(--lu-ink); background: transparent; font-family: var(--lu-font);
    }
    dialog::backdrop { background: transparent; }
    .scrim {
      position: absolute; inset: 0; display: flex; align-items: flex-end; justify-content: center;
      padding: var(--lu-space-4); touch-action: none; background: var(--lu-scrim); backdrop-filter: var(--ha-dialog-scrim-backdrop-filter, none);
      animation: scrim-in var(--lu-motion-layer) var(--lu-ease) both;
    }
    .sheet {
      display: flex; flex-direction: column; width: min(100%, 640px); max-height: var(--lu-sheet-max, min(86dvh, 820px));
      border: 1px solid var(--lu-edge); border-radius: var(--lu-radius-sheet); background: var(--lu-sheet);
      box-shadow: var(--lu-highlight-rest), var(--lu-shadow-rest); touch-action: pan-y;
      animation: sheet-in var(--lu-motion-layer) var(--lu-ease) both;
      transition: transform var(--lu-motion-layer) var(--lu-ease);
    }
    .leaving .scrim, .scrim.leaving { animation: scrim-out var(--lu-motion-exit) var(--lu-ease-exit) both; }
    .leaving .sheet { animation: sheet-out var(--lu-motion-exit) var(--lu-ease-exit) both; }
    .grab { touch-action: none; }
    .handle { display: none; width: 40px; height: 4px; margin: var(--lu-space-3) auto 0; border-radius: var(--lu-radius-pill); background: var(--lu-track-off); }
    .head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--lu-space-3); padding: var(--lu-space-4) var(--lu-space-5) var(--lu-space-3); }
    .titles { min-width: 0; padding-top: var(--lu-space-1); }
    h2 { font-size: var(--lu-type-title); font-weight: 620; letter-spacing: -.012em; line-height: 1.25; overflow-wrap: anywhere; }
    .sub { margin-top: var(--lu-space-1); color: var(--lu-ink-2); font-size: var(--lu-type-label); }
    .body { min-height: 0; padding: 0 var(--lu-space-5) var(--lu-space-5); overflow-y: auto; overscroll-behavior: contain; }
    @keyframes scrim-in { from { opacity: 0; } }
    @keyframes scrim-out { to { opacity: 0; } }
    @keyframes sheet-in { from { opacity: 0; transform: translateY(var(--lu-travel-layer, 24px)); } }
    @keyframes sheet-out { to { opacity: 0; transform: translateY(var(--lu-travel-layer, 24px)); } }
    @container (max-width: 680px) {
      .scrim { padding: 0; }
      .sheet { width: 100%; max-height: var(--lu-sheet-max, min(90dvh, 860px)); border-radius: var(--lu-radius-sheet) var(--lu-radius-sheet) 0 0; }
      .handle { display: block; }
      .head { padding-top: var(--lu-space-3); }
      .body { padding-bottom: calc(var(--lu-space-5) + env(safe-area-inset-bottom)); }
    }
  `];

  render() {
    return html`<dialog aria-labelledby="title" @cancel=${this._onCancel}>
      <div class=${this._leaving ? "scrim leaving" : "scrim"} @pointerdown=${this._onScrimDown} @click=${this._onScrim} @wheel=${this._onWheel}>
        <section class="sheet">
          <div class="grab" @pointerdown=${this._onDragStart} @pointermove=${this._onDragMove} @pointerup=${this._onDragEnd} @pointercancel=${this._onDragEnd}>
            <div class="handle" aria-hidden="true"></div>
            <header class="head">
              <div class="titles"><h2 id="title">${this.heading}</h2>${this.subheading ? html`<p class="sub">${this.subheading}</p>` : nothing}</div>
              <button class="icon-button close" type="button" aria-label=${this.closeLabel} @click=${() => this.close()}><ha-icon .icon=${"mdi:close"}></ha-icon></button>
            </header>
          </div>
          <div class="body"><slot></slot></div>
        </section>
      </div>
    </dialog>`;
  }
}

customElements.define("kestrel-sheet", KestrelSheet);

declare global { interface HTMLElementTagNameMap { "kestrel-sheet": KestrelSheet; } }
