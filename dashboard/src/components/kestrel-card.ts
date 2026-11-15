import { InViewController, clearSwr, readSwr, subscribeSwr, swr, type SwrSnapshot } from "lucent-ha";
import { LitElement, html, type TemplateResult } from "lit";
import { isSigned, signatureRejected, signedLinkExpired } from "../recovery.ts";
import type { HomeAssistant } from "../types.ts";
import { forgetStableUrls } from "../urls.ts";

/** How long an answer counts as fresh. Cards keep nothing in storage (unlike the panel): a dashboard is often open for another person on the same browser. */
const FRESH_MS = 30_000;
/** How often a card on screen asks again, which also keeps "3 min ago" honest. */
const POLL_MS = 60_000;
/** A picture that fails is looked into at most this often. */
const RECOVER_MS = 60_000;

/** The part both cards share: a question (a key and how to ask), asked when the card is first on screen and again every minute while it is on screen and the page is in front;
 * the last good answer stays on screen when asking fails. What to draw for an answer is the card's own business: `renderCard` adds the frame, `renderAnswer` the states around it.
 * Cards asking the same question share one request and one answer: the key is the question's name. */
export abstract class KestrelDataCard<Data> extends LitElement {
  static properties = { _snapshot: { state: true } };

  declare _snapshot: SwrSnapshot<Data> | undefined;

  private _hass: HomeAssistant | undefined;
  private _key = "";
  private _question: ((hass: HomeAssistant) => Promise<Data>) | undefined;
  private _stopWatching: (() => void) | undefined;
  private _timer: number | undefined;
  private _lastRecovery = 0;
  private readonly _view = new InViewController(this, { rootMargin: "200px", onChange: (visible) => this._onView(visible) });

  /** Home Assistant hands over a new `hass` for every change in the house: this keeps the latest for asking, and draws nothing for it. */
  set hass(value: HomeAssistant) {
    const first = this._hass === undefined;
    this._hass = value;
    if (first) this._refresh();
  }

  get hass(): HomeAssistant | undefined { return this._hass; }

  /** Settles on a question. The same one again changes nothing; another one starts from what is already known about it. */
  protected ask(key: string, question: (hass: HomeAssistant) => Promise<Data>): void {
    this._question = question;
    if (key !== this._key) {
      this._stopWatching?.();
      this._stopWatching = undefined;
      this._key = key;
      this._snapshot = readSwr<Data>(key);
    }
    this._watch();
    this._refresh();
  }

  connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("visibilitychange", this._onVisibility);
    this._watch();
    this._refresh();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener("visibilitychange", this._onVisibility);
    this._stopWatching?.();
    this._stopWatching = undefined;
    this._stopTimer();
  }

  private _watch(): void {
    if (this._stopWatching || !this._key || !this.isConnected) return;
    this._stopWatching = subscribeSwr<Data>(this._key, (snapshot) => { this._snapshot = snapshot; });
  }

  /** Asks the question with the newest `hass`. */
  private _fetch = (): Promise<Data> => {
    const hass = this._hass;
    const question = this._question;
    return hass && question ? question(hass) : Promise.reject(new Error("Home Assistant is not connected."));
  };

  /** Asks again if what is known is older than a moment; a card that has not been given Home Assistant yet, or a question, waits. */
  private _refresh(): void {
    if (this._question && this._key && this._hass) this._snapshot = swr<Data>(this._key, this._fetch, { maxAgeMs: FRESH_MS });
  }

  private _onView(visible: boolean): void {
    if (!visible) { this._stopTimer(); return; }
    this._refresh();
    this._timer ??= window.setInterval(() => { if (document.visibilityState === "visible") { this._refresh(); this.requestUpdate(); } }, POLL_MS);
  }

  private _stopTimer(): void {
    window.clearInterval(this._timer);
    this._timer = undefined;
  }

  private _onVisibility = (): void => {
    if (document.visibilityState === "visible" && this._view.visible) { this._refresh(); this.requestUpdate(); }
  };

  /** Asks again now, whatever is known. */
  protected retry = (): void => {
    if (this._question && this._key && this._hass) void swr<Data>(this._key, this._fetch, { maxAgeMs: FRESH_MS }).revalidate();
  };

  /** A picture failed for good. When its link is a signed one that Home Assistant no longer accepts (its key changed, or the link ran out) the answer's links are all dead:
   * ask again for new ones, at most once a minute. */
  private _onImageError = (event: Event): void => {
    const detail: unknown = event instanceof CustomEvent ? event.detail : undefined;
    const src = typeof detail === "object" && detail !== null && "src" in detail && typeof detail.src === "string" ? detail.src : null;
    if (!isSigned(src) || Date.now() - this._lastRecovery < RECOVER_MS) return;
    this._lastRecovery = Date.now();
    const recover = (): void => { forgetStableUrls(); clearSwr(this._key); this._refresh(); };
    if (signedLinkExpired(src)) { recover(); return; }
    void signatureRejected(src).then((rejected) => { if (rejected) recover(); });
  };

  /** The card's frame: Home Assistant's card around the toolkit's card root, which brings the theme's tokens. */
  protected renderCard(body: TemplateResult): TemplateResult {
    return html`<ha-card><kestrel-lu-root mode="card" @lu-image-error=${this._onImageError}>${body}</kestrel-lu-root></ha-card>`;
  }

  /** What to draw for the state of the question: nothing known yet (`loading`), nothing and an error, or an answer, which stays under a "couldn't refresh" strip while the last ask failed. */
  protected renderAnswer(answer: (data: Data) => TemplateResult, loading: TemplateResult): TemplateResult {
    const snapshot = this._snapshot;
    const data = snapshot?.data;
    const failed = snapshot?.error !== undefined;
    if (data === undefined) {
      return failed
        ? html`<kestrel-lu-state kind="error" heading="Couldn't load wildlife" message="Kestrel did not answer. Home Assistant may be starting." @lu-retry=${this.retry}></kestrel-lu-state>`
        : loading;
    }
    return failed
      ? html`<kestrel-lu-state kind="error" compact heading="Couldn't refresh" message="Showing the last answer." @lu-retry=${this.retry}>${answer(data)}</kestrel-lu-state>`
      : answer(data);
  }
}

interface CustomCardsWindow extends Window { customCards?: Array<Record<string, unknown>> }

/** Lists a card in Home Assistant's card picker, with a live preview there. `type` is the element's name. */
export function listCard(type: string, name: string, description: string): void {
  const registry = window as CustomCardsWindow;
  registry.customCards = registry.customCards ?? [];
  registry.customCards.push({ type, name, description, preview: true });
}
