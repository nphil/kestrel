import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { captureFrame, frameFor, noteRatio, pictureSize, ratioFor, type PictureSource } from "../live-frames.ts";
import type { HomeAssistant } from "../types.ts";

type Card = HTMLElement & { hass?: HomeAssistant; setConfig?: (config: Record<string, unknown>) => void };
type Phase = "idle" | "connecting" | "live" | "failed";
/** One Scrypted card, the slot that fades it in, and when it was started. */
interface Layer { slot: HTMLElement; card: Card; at: number }

const POLL_MS = 60;
const SLOW_POLL_MS = 1000;
/** How long we wait for a first picture before saying so. */
const FAIL_AFTER_MS = 12_000;
/** How long a second stream may take before we stop waiting for it. */
const GIVE_UP_MS = 6_000;
/** The focused view asks for a sharper stream once the small one is flowing, or after this long if it is not. */
const SHARP_DELAY_MS = 800;
/** If the card rendered something but has no <video> we can read, stop guessing and show it as it is. */
const OPAQUE_AFTER_MS = 3_000;
/** A slot is fully faded in (and whatever it covers can go) after this long. */
const FADE_MS = 300;
const DEFAULT_RATIO = 16 / 9;

// Scrypted's card rejects a promise with Error("closed") when it is removed before its video has
// connected (a quick tap, a tile scrolling away). Nothing is wrong, so keep that one expected
// rejection out of the console instead of reporting it as a page error.
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason as { message?: unknown } | null;
  if (reason && typeof reason === "object" && reason.message === "closed") event.preventDefault();
});

/** How long a tile that has left the screen keeps streaming before it stops. */
const LEAVE_MS = 2000;

/** Cards start one at a time, a short gap apart. Creating a Scrypted card takes real time; four at once
 * would hold the page still for a fifth of a second, and a tab switch or a scroll must stay smooth. */
const MOUNT_GAP_MS = 90;
const mountQueue: Array<() => boolean> = [];
let mountTimer: number | undefined;

function drainMounts(): void {
  mountTimer = undefined;
  while (mountQueue.length) {
    const mounted = mountQueue.shift()?.();
    if (mounted) break; // one real mount per turn
  }
  if (mountQueue.length) mountTimer = window.setTimeout(drainMounts, MOUNT_GAP_MS);
}

/** Queues a mount; it runs after the next paint. The task returns true when it actually created a card. */
function queueMount(task: () => boolean): void {
  mountQueue.push(task);
  if (mountTimer === undefined) mountTimer = window.setTimeout(() => window.requestAnimationFrame(() => window.setTimeout(drainMounts, 0)), 0);
}

// One observer serves every tile: tiles near the screen play, tiles far away stop.
const watchers = new WeakMap<Element, (visible: boolean) => void>();
let observer: IntersectionObserver | undefined;

function watch(element: Element, callback: (visible: boolean) => void): void {
  observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries) watchers.get(entry.target)?.(entry.isIntersecting);
  }, { rootMargin: "120px" });
  watchers.set(element, callback);
  observer.observe(element);
}

function unwatch(element: Element): void {
  observer?.unobserve(element);
  watchers.delete(element);
}

/** The card's own <video> (or, for snapshot tiles, its <img>) once it has a picture we can read. */
function pictureOf(card: Card | undefined, live: boolean): PictureSource | null {
  const root = card?.shadowRoot;
  if (!root) return null;
  if (live) {
    const video = root.querySelector("video");
    return video && video.readyState >= 2 && video.videoWidth > 0 ? video : null;
  }
  const image = root.querySelector("img");
  return image && image.complete && image.naturalWidth > 0 ? image : null;
}

/** One camera's live picture, from a grid tile or the focused view.
 *
 * The element owns the whole life of its Scrypted cards: it starts them when it is on screen,
 * stops them (keeping the last picture) when it is not, and is always cleaned up with the element
 * itself, so there is no list of players anywhere that can go stale.
 *
 * A tile runs one small stream. The focused view starts with that same small stream, which is usually
 * flowing within a moment, and only asks for a sharper one when the small one is too narrow for the
 * screen it is on; the sharper stream replaces it once it arrives. A slow high-quality stream therefore
 * never holds the picture back, and small screens never pay for it. */
export class KestrelLivePlayer extends LitElement {
  static properties = {
    cameraId: { type: String },
    nvrCardId: { attribute: false },
    label: { type: String },
    mode: { type: String, reflect: true },
    live: { type: Boolean },
    paused: { type: Boolean },
    scryptedUrl: { type: String },
    phase: { type: String, reflect: true },
    _poster: { state: true },
  };

  declare cameraId: string;
  declare nvrCardId: string | number | null;
  declare label: string;
  declare mode: "tile" | "focus";
  declare live: boolean;
  /** The view this player is in is out of sight: stop the cards (keeping the last picture), start again when cleared. */
  declare paused: boolean;
  declare scryptedUrl: string;
  declare phase: Phase;
  declare _poster: boolean;

  /** Focused view only: which sharper stream to ask for when one is needed. Read each time the player starts. */
  wide = false;

  private _hass?: HomeAssistant;
  private _layers: Layer[] = [];
  private _current?: Layer;
  /** Focused view: the destination of the sharper stream, until it has been asked for (or ruled out). */
  private _sharp?: string;
  private _shownAt = 0;
  private _inView = false;
  private _running = false;
  private _seen = false;
  private _epoch = 0;
  private _timer?: number;
  private _startedAt = 0;
  private _ratio = 0;
  private _pauseTimer?: number;
  private _leaveTimer?: number;

  constructor() {
    super();
    this.cameraId = "";
    this.nvrCardId = null;
    this.label = "";
    this.mode = "tile";
    this.live = true;
    this.paused = false;
    this.scryptedUrl = "";
    this.phase = "idle";
    this._poster = false;
  }

  get hass(): HomeAssistant | undefined { return this._hass; }
  set hass(value: HomeAssistant | undefined) {
    this._hass = value;
    if (value) for (const { card } of this._layers) card.hass = value;
  }

  /** Copy the picture on screen into the cache now, e.g. just before the user taps through to another view. */
  capture(): boolean {
    let picture = this._current ? pictureOf(this._current.card, this.live) : null;
    for (let i = this._layers.length - 1; i >= 0 && !picture; i--) picture = pictureOf(this._layers[i].card, this.live);
    return captureFrame(this.cameraId, picture);
  }

  connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("visibilitychange", this._sync);
    if (this.hasUpdated) { this._paintPoster(); this._arm(); }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener("visibilitychange", this._sync);
    window.clearTimeout(this._pauseTimer);
    window.clearTimeout(this._leaveTimer);
    unwatch(this);
    this._stop(true);
    this._releasePoster();
  }

  protected willUpdate(changed: PropertyValues<this>): void {
    if (!this.hasUpdated && this.mode === "focus") this.phase = "connecting";
    if (this.mode === "focus" && (!this.hasUpdated || changed.has("cameraId"))) this._setRatio(ratioFor(this.cameraId) ?? DEFAULT_RATIO);
  }

  protected firstUpdated(): void {
    this._paintPoster();
    this._arm();
  }

  protected updated(changed: PropertyValues<this>): void {
    if (!this._seen) { this._seen = true; return; }
    if (changed.has("paused") && !changed.has("cameraId") && !changed.has("nvrCardId") && !changed.has("live")) {
      window.clearTimeout(this._pauseTimer);
      // Tearing down a dozen cards in one task would stall the page, so each pauses at its own moment.
      if (this.paused) this._pauseTimer = window.setTimeout(this._sync, Math.random() * 700);
      else this._sync();
      return;
    }
    if (!changed.has("cameraId") && !changed.has("nvrCardId") && !changed.has("live")) return;
    const previous = changed.get("cameraId") as string | undefined;
    const switched = previous !== undefined && previous !== this.cameraId;
    if (this._layers.length) this._stop(!switched); // a different camera must not inherit this camera's last picture
    else if (switched) this._paintPoster();
    this._sync();
  }

  private _arm(): void {
    if (this.mode === "focus" || typeof IntersectionObserver === "undefined") {
      this._inView = true;
      this._sync();
    } else {
      watch(this, (visible) => {
        window.clearTimeout(this._leaveTimer);
        if (visible) { this._inView = true; this._sync(); return; }
        // Out of sight: keep going briefly, so flipping tabs or a small scroll doesn't restart the stream, and
        // stop each tile at its own moment rather than all of them in one task.
        this._leaveTimer = window.setTimeout(() => { this._inView = false; this._sync(); }, LEAVE_MS + Math.random() * 700);
      });
    }
  }

  private _sync = (): void => {
    if (this._inView && !this.paused && document.visibilityState !== "hidden") this._start();
    else this._stop(true);
  };

  private _start(): void {
    if (this._running || this.nvrCardId == null) return;
    this._running = true;
    const epoch = ++this._epoch;
    this._startedAt = performance.now();
    this.phase = "connecting";
    // A tile starts after the next paint, so coming back to a view shows it before the cards go to work;
    // the focused view is what the user just asked for and starts at once.
    void customElements.whenDefined("scrypted-nvr-camera").then(() => {
      if (epoch !== this._epoch) return;
      if (this.mode === "focus") this._mount();
      else queueMount(() => { if (epoch !== this._epoch) return false; this._mount(); return true; });
    });
    this._schedule(POLL_MS);
  }

  private _mount(): void {
    if (!this._running || this._layers.length) return;
    this._addLayer("low-resolution");
    this._sharp = this.mode === "focus" && this.live ? (this.wide ? "local" : "remote") : undefined;
  }

  private _addLayer(destination: string): void {
    const stage = this.renderRoot.querySelector<HTMLElement>(".stage");
    if (!stage) return;
    const card = document.createElement("scrypted-nvr-camera") as Card;
    // The card only starts its video when it already has its config and hass as it joins the page,
    // so it is fully set up before its slot is inserted.
    card.setConfig?.({ type: "custom:scrypted-nvr-camera", id: String(this.nvrCardId), destination, live: this.live, imageClick: "none", videoClick: "none" });
    if (this._hass) card.hass = this._hass;
    card.setAttribute("aria-label", `${this.label} ${this.live ? "live view" : "snapshot"}`);
    const slot = document.createElement("div");
    slot.className = "slot";
    slot.append(card);
    this._layers.push({ slot, card, at: performance.now() });
    stage.append(slot);
  }

  /** Stop the cards. The last picture is copied first so the next view never starts from grey. */
  private _stop(capture: boolean): void {
    this._running = false;
    this._epoch++;
    window.clearTimeout(this._timer);
    this._sharp = undefined;
    const had = this._layers.length > 0;
    if (had) {
      if (capture) this.capture();
      this.renderRoot.querySelector(".stage")?.replaceChildren();
      this._layers = [];
      this._current = undefined;
    }
    this.phase = "idle";
    if (had && this.isConnected) this._paintPoster();
  }

  private _schedule(ms: number): void {
    window.clearTimeout(this._timer);
    this._timer = window.setTimeout(this._tick, ms);
  }

  /** Shows the sharpest card that has a picture, tidies up cards that are no longer needed, and raises the flag if nothing comes. */
  private _tick = (): void => {
    if (!this._running) return;
    const now = performance.now();
    const waited = now - this._startedAt;
    const current = this._current ? this._layers.indexOf(this._current) : -1;
    for (let i = this._layers.length - 1; i > current; i--) {
      const picture = pictureOf(this._layers[i].card, this.live);
      if (!picture) continue;
      const shown = this._current ? pictureOf(this._current.card, this.live) : null;
      // a second stream that is not wider than the one already showing adds nothing, so it is dropped rather than swapped in
      if (!shown || pictureSize(picture)[0] > pictureSize(shown)[0] * 1.1) this._show(this._layers[i], picture);
      else this._discard([this._layers[i]]);
      break;
    }
    if (this._sharp) {
      const small = this._layers[0] && pictureOf(this._layers[0].card, this.live);
      if (small && pictureSize(small)[0] >= Math.min(1280, this.clientWidth * (window.devicePixelRatio || 1)) * 0.8) this._sharp = undefined; // already as wide as the screen can show
      else if (small || waited > SHARP_DELAY_MS) { this._addLayer(this._sharp); this._sharp = undefined; }
    }
    const first = this._layers[0]?.card;
    const root = first?.shadowRoot;
    if (!this._current && first && (!root || (waited > OPAQUE_AFTER_MS && [...root.children].some((el) => el.localName !== "style") && !root.querySelector(this.live ? "video" : "img")))) {
      this._show(this._layers[0], null); // we can't look inside this card, so show it as it is
      this._discard(this._layers.slice(1));
    }
    if (!this._current && waited > FAIL_AFTER_MS && this.phase !== "failed") this.phase = "failed";
    this._tidy(now);
    if (this._layers.length > 1 || this._sharp || !this._current) this._schedule(this.phase === "failed" ? SLOW_POLL_MS : POLL_MS);
  };

  private _show(layer: Layer, picture: PictureSource | null): void {
    this._current = layer;
    this._shownAt = performance.now();
    if (picture) {
      const [width, height] = pictureSize(picture);
      noteRatio(this.cameraId, width, height);
      if (this.mode === "focus") this._setRatio(width / height);
    }
    const epoch = this._epoch;
    // Two frames give the card's canvas time to paint its first picture before it fades in.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (epoch !== this._epoch || this._current !== layer) return;
      layer.slot.classList.add("shown");
      this.phase = "live";
      this._shownAt = performance.now();
      this.capture(); // a first picture on file, in case a later capture finds the stream mid-refresh
    }));
  }

  /** Cards under the picture can go once it has faded in and they have connected (never mid-connection, which Scrypted's card handles badly); a sharper card that never arrives is given up on. */
  private _tidy(now: number): void {
    if (!this._current) return;
    const at = this._layers.indexOf(this._current);
    const stale = (layer: Layer): boolean => now - layer.at > GIVE_UP_MS;
    const faded = now - this._shownAt > FADE_MS;
    this._discard([
      ...this._layers.slice(0, at).filter((layer) => faded && (stale(layer) || pictureOf(layer.card, this.live))),
      ...this._layers.slice(at + 1).filter(stale),
    ]);
  }

  private _discard(layers: Layer[]): void {
    if (!layers.length) return;
    for (const layer of layers) layer.slot.remove();
    this._layers = this._layers.filter((layer) => !layers.includes(layer));
  }

  private _setRatio(ratio: number): void {
    if (Math.abs(ratio - this._ratio) < 0.005) return;
    this._ratio = ratio;
    this.style.setProperty("--ratio", ratio.toFixed(4));
  }

  private _paintPoster(): void {
    const canvas = this.renderRoot.querySelector<HTMLCanvasElement>("canvas.poster");
    const frame = frameFor(this.cameraId);
    if (!canvas || !frame) { this._poster = false; return; }
    if (canvas.width !== frame.width) canvas.width = frame.width;
    if (canvas.height !== frame.height) canvas.height = frame.height;
    canvas.getContext("2d")?.drawImage(frame, 0, 0);
    this._poster = true;
  }

  /** The poster's pixels are not needed once the live picture is showing, or once the element is gone. */
  private _releasePoster(): void {
    const canvas = this.renderRoot.querySelector<HTMLCanvasElement>("canvas.poster");
    if (canvas) { canvas.width = 0; canvas.height = 0; }
    this._poster = false;
  }

  private _onFaded(event: TransitionEvent): void {
    if (event.propertyName === "opacity" && this.phase === "live" && (event.target as HTMLElement).classList?.contains("slot")) this._releasePoster();
  }

  private _retry(): void {
    this._stop(false);
    this._sync();
  }

  static styles = [css`
    :host { position: relative; display: block; overflow: hidden; background: var(--lu-tile); }
    :host([mode="focus"]) { width: min(100%, calc(min(70vh, 880px) * var(--ratio, 1.7778))); aspect-ratio: var(--ratio, 1.7778); margin-inline: auto; border-radius: var(--lu-radius-card); }
    .layer, .stage, .slot { position: absolute; inset: 0; }
    .layer, .slot { display: flex; align-items: center; justify-content: center; overflow: hidden; }
    canvas, .slot > * { display: block; flex: none; width: 100%; }
    canvas { height: auto; }
    canvas[hidden] { display: none; }
    .slot { opacity: 0; transition: opacity var(--lu-motion-layer) var(--lu-ease); }
    .slot.shown { opacity: 1; }
    :host([phase="live"]) .backdrop { visibility: hidden; transition: visibility 0s linear var(--lu-motion-layer); }
    :host([phase="failed"]) canvas { opacity: .4; filter: grayscale(1); }
    .chip { position: absolute; left: var(--lu-space-2); bottom: var(--lu-space-2); display: inline-flex; min-height: 28px; align-items: center; padding: 0 var(--lu-space-3); border: 1px solid var(--lu-edge); border-radius: var(--lu-radius-pill); color: var(--lu-ink-2); background: var(--lu-reading); font-size: var(--lu-type-caption); pointer-events: none; }
    .hint { position: absolute; inset: 0; display: grid; place-items: center; color: var(--lu-ink-3); font-size: var(--lu-type-caption); pointer-events: none; }
    .failure { position: absolute; inset: 0; display: grid; align-content: center; justify-items: center; gap: var(--lu-space-3); padding: var(--lu-space-5); color: var(--lu-ink-2); background: var(--lu-reading); text-align: center; }
    .failure ha-icon { --mdc-icon-size: 32px; width: 32px; height: 32px; color: var(--lu-ink-3); }
    .failure strong { color: var(--lu-ink); font-size: var(--lu-type-title); font-weight: 600; }
    .actions { display: flex; flex-wrap: wrap; justify-content: center; gap: var(--lu-space-2); }
    .action { display: inline-flex; min-height: var(--lu-target); align-items: center; justify-content: center; padding: 0 var(--lu-space-5); border: 1px solid var(--lu-edge-raised); border-radius: var(--lu-radius-pill); color: var(--lu-ink); background: var(--lu-glass-raised); box-shadow: var(--lu-highlight-rest); font: 600 var(--lu-type-label) var(--lu-font); text-decoration: none; cursor: pointer; }
    .action.primary { border-color: transparent; color: var(--lu-accent-ink); background: var(--lu-accent); }
    .action:focus-visible { outline: 2px solid var(--lu-accent); outline-offset: 2px; }
  `];

  private _status() {
    if (this.phase === "failed") {
      if (this.mode !== "focus") return html`<span class="chip">No video</span>`;
      return html`<div class="failure" role="alert"><ha-icon .icon=${"mdi:video-off-outline"} aria-hidden="true"></ha-icon><strong>No live video from this camera right now</strong><div class="actions"><button class="action primary" type="button" @click=${this._retry}>Retry</button>${this.scryptedUrl ? html`<a class="action" href=${this.scryptedUrl} target="_blank" rel="noopener noreferrer">Open in Scrypted</a>` : nothing}</div></div>`;
    }
    if (this.phase !== "connecting") return nothing;
    if (!this._poster) return html`<span class="hint">${this.mode === "focus" ? "Connecting to live view…" : "Connecting…"}</span>`;
    return this.mode === "focus" ? html`<span class="chip">Connecting…</span>` : nothing;
  }

  render() {
    return html`<div class="layer backdrop"><canvas class="poster" ?hidden=${!this._poster}></canvas></div>
      <div class="stage" @transitionend=${this._onFaded}></div>
      ${this._status()}`;
  }
}

customElements.define("kestrel-live-player", KestrelLivePlayer);

declare global { interface HTMLElementTagNameMap { "kestrel-live-player": KestrelLivePlayer; } }
