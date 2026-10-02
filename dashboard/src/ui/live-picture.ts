import { LitElement, css, html, nothing } from "lit";
import { pathOf, sameMedia } from "../urls.ts";

/** One shared observer tells each picture whether it is on screen: a scrolled-away tile or a hidden view isn't. */
const watchers = new Map<Element, (visible: boolean) => void>();
let observer: IntersectionObserver | undefined;

function watch(element: Element, listener: (visible: boolean) => void): () => void {
  observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries) watchers.get(entry.target)?.(entry.isIntersecting);
  });
  watchers.set(element, listener);
  observer.observe(element);
  return () => { watchers.delete(element); observer?.unobserve(element); };
}

/** The last picture of each source, so a tile that becomes the focused view (and back) starts from it, not from a blank. */
interface Kept { blob: Blob; takenAt: number | null; etag: string; at: number }
const kept = new Map<string, Kept>();
const KEEP_MS = 10 * 60_000;
const MAX_KEPT = 32;

function remember(key: string, entry: Kept): void {
  kept.delete(key);
  kept.set(key, entry);
  for (const [other, value] of kept) if (kept.size > MAX_KEPT || Date.now() - value.at > KEEP_MS) kept.delete(other);
}

const MAX_BACKOFF_MS = 60_000;
/** A picture taken longer ago than this isn't live any more, and says when it was taken. */
const STALE_AFTER_MS = 60_000;

/** A link the browser can load: absolute, or rooted at the site. A bare path such as `media/live/1.jpg` would resolve
 * under the panel's own address and never load, so it counts as "no picture yet". */
function loadable(src: string): boolean { return /^(?:https?:)?\/\/|^\//.test(src); }

function ageText(takenAt: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - takenAt) / 1000));
  if (seconds < 3_600) return `Updated ${Math.max(1, Math.round(seconds / 60))} min ago`;
  if (seconds < 86_400) return `Updated ${Math.round(seconds / 3_600)} h ago`;
  return `Updated ${Math.round(seconds / 86_400)} d ago`;
}

/** A picture that keeps itself current while someone can see it.
 *
 * The source is fetched again every `interval` ms (never faster than the server hands out new pictures, about 15 s),
 * but only while the element is on screen, not `paused` and the page is visible: nothing is asked of a camera that
 * nobody is looking at. The same link is fetched each time (signed links reject extra query parameters), as a
 * conditional request when the server sent an ETag, and the previous picture stays up until the next one is fully
 * decoded. A picture older than a minute (`Last-Modified`) carries an "Updated 3 min ago" chip, so an old frame is
 * never passed off as live. A failure keeps the last picture and retries with growing gaps (up to a minute); a link
 * that is refused (401/403) fires `kestrel-picture-expired`, so the owner can fetch fresh links. */
export class KestrelLivePicture extends LitElement {
  static properties = {
    src: { type: String },
    alt: { type: String },
    wide: { type: Boolean, reflect: true },
    paused: { type: Boolean },
    interval: { type: Number },
    _url: { state: true },
    _phase: { state: true },
    _takenAt: { state: true },
  };

  declare src: string;
  declare alt: string;
  declare wide: boolean;
  declare paused: boolean;
  declare interval: number;
  declare _url: string;
  declare _phase: "loading" | "failed" | "none";
  declare _takenAt: number | null;

  private _visible = false;
  private _pageVisible = document.visibilityState === "visible";
  private _timer = 0;
  private _request?: AbortController;
  private _lastStart = 0;
  private _failures = 0;
  private _size = 0;
  private _etag = "";
  private _unwatch?: () => void;

  constructor() {
    super();
    this.src = "";
    this.alt = "";
    this.wide = false;
    this.paused = false;
    this.interval = 16_000;
    this._url = "";
    this._phase = "none";
    this._takenAt = null;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this._pageVisible = document.visibilityState === "visible";
    document.addEventListener("visibilitychange", this._onPage);
    this._unwatch = watch(this, (visible) => { this._visible = visible; this._sync(); });
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener("visibilitychange", this._onPage);
    this._unwatch?.();
    this._unwatch = undefined;
    this._visible = false;
    this._stop();
    this._release();
  }

  willUpdate(changed: Map<string, unknown>): void {
    if (!changed.has("src")) return;
    const before = changed.get("src") as string | undefined;
    // The same picture under a new signature carries on; a different camera starts over.
    if (before && !sameMedia(before, this.src)) { this._stop(); this._release(); this._failures = 0; }
    if (!this._url) this._restore();
    if (!loadable(this.src)) this._phase = "none";
    else if (this._phase === "none") this._phase = "loading";
  }

  updated(changed: Map<string, unknown>): void {
    // A new pace applies from now on, not after the wait that was already running.
    if (changed.has("interval") && this._timer) this._stop();
    if (changed.has("src") || changed.has("paused") || changed.has("interval")) this._sync();
  }

  private _onPage = (): void => {
    this._pageVisible = document.visibilityState === "visible";
    this._sync();
  };

  private _active(): boolean { return loadable(this.src) && !this.paused && this._visible && this._pageVisible; }
  private _period(): number { return Math.max(250, this.interval); }

  /** After a failure the gap doubles up to a minute; pictures of different cameras don't ask in lockstep. */
  private _next(): number {
    const wait = this._failures ? Math.min(this._period() * 2 ** (this._failures - 1), MAX_BACKOFF_MS) : this._period();
    return wait + Math.random() * 1_500;
  }

  private _sync(): void {
    if (!this._active()) { this._stop(); return; }
    if (this._timer || this._request) return;
    this._schedule(Math.max(0, this._lastStart + this._period() - Date.now()));
  }

  private _schedule(delay: number): void {
    window.clearTimeout(this._timer);
    this._timer = window.setTimeout(() => { void this._fetch(); }, delay);
  }

  /** Nothing in flight, nothing scheduled; the picture on screen stays. A request cut short doesn't count as an attempt. */
  private _stop(): void {
    window.clearTimeout(this._timer);
    this._timer = 0;
    if (this._request) {
      this._request.abort();
      this._request = undefined;
      this._lastStart = 0;
    }
  }

  private _restore(): void {
    if (!loadable(this.src)) return;
    const entry = kept.get(pathOf(this.src));
    if (!entry || Date.now() - entry.at > KEEP_MS) return;
    this._url = URL.createObjectURL(entry.blob);
    this._takenAt = entry.takenAt;
    this._size = entry.blob.size;
    this._etag = entry.etag;
  }

  private _release(): void {
    if (this._url) URL.revokeObjectURL(this._url);
    this._url = "";
    this._takenAt = null;
    this._size = 0;
    this._etag = "";
    this._lastStart = 0;
  }

  private async _fetch(): Promise<void> {
    this._timer = 0;
    if (!this._active()) return;
    const request = new AbortController();
    this._request = request;
    this._lastStart = Date.now();
    let refused = false;
    try {
      const headers: Record<string, string> = {};
      if (this._url && this._etag) headers["If-None-Match"] = this._etag;
      const response = await fetch(this.src, { cache: "no-store", credentials: "same-origin", headers, signal: request.signal });
      if (response.status === 304 && this._url) this.requestUpdate(); // the same picture again; only its age text moves on
      else {
        if (!response.ok) { refused = response.status === 401 || response.status === 403; throw new Error(`HTTP ${response.status}`); }
        const blob = await response.blob();
        if (!blob.size || !blob.type.startsWith("image/")) throw new Error("Not a picture");
        const modified = Date.parse(response.headers.get("Last-Modified") ?? "");
        const takenAt = Number.isFinite(modified) ? modified : null;
        if (this._url && takenAt !== null && takenAt === this._takenAt && blob.size === this._size) this.requestUpdate();
        else await this._show(blob, takenAt, response.headers.get("ETag") ?? "", request.signal);
      }
      this._failures = 0;
    } catch {
      if (request.signal.aborted) return;
      this._failures += 1;
      if (!this._url) this._phase = "failed";
      if (refused) this.dispatchEvent(new CustomEvent("kestrel-picture-expired", { bubbles: true, composed: true }));
    } finally {
      if (this._request === request) this._request = undefined;
    }
    if (this._active()) this._schedule(this._next());
  }

  /** Puts a new picture up once it is fully decoded, so the swap never flashes. */
  private async _show(blob: Blob, takenAt: number | null, etag: string, signal: AbortSignal): Promise<void> {
    const url = URL.createObjectURL(blob);
    try {
      const probe = new Image();
      probe.src = url;
      await probe.decode();
    } catch {
      URL.revokeObjectURL(url);
      throw new Error("Not a picture");
    }
    if (signal.aborted) { URL.revokeObjectURL(url); return; }
    const previous = this._url;
    this._url = url;
    this._takenAt = takenAt;
    this._size = blob.size;
    this._etag = etag;
    remember(pathOf(this.src), { blob, takenAt, etag, at: Date.now() });
    if (previous) window.setTimeout(() => URL.revokeObjectURL(previous), 2_000);
  }

  static styles = [css`
    :host { position: relative; display: block; width: 100%; aspect-ratio: 4 / 3; overflow: hidden; border-radius: var(--lu-radius-tile); background: var(--lu-tile); }
    :host([wide]) { aspect-ratio: 16 / 10; }
    .frame { display: grid; width: 100%; height: 100%; min-height: 0; place-items: center; overflow: hidden; color: var(--lu-ink-3); }
    img { display: block; width: 100%; height: 100%; object-fit: cover; }
    .empty { display: grid; justify-items: center; gap: var(--lu-space-2); padding: var(--lu-space-4); font-size: var(--lu-type-caption); text-align: center; }
    ha-icon { --mdc-icon-size: 28px; width: 28px; height: 28px; opacity: .66; }
    .age { position: absolute; left: var(--lu-space-2); bottom: var(--lu-space-2); display: inline-flex; min-height: 28px; align-items: center; padding: 0 var(--lu-space-3); border: 1px solid var(--lu-edge); border-radius: var(--lu-radius-pill); color: var(--lu-ink-2); background: var(--lu-reading); font-size: var(--lu-type-caption); font-variant-numeric: tabular-nums; pointer-events: none; }
  `];

  render() {
    const stale = this._takenAt !== null && Date.now() - this._takenAt > STALE_AFTER_MS;
    const label = this._phase === "loading" ? "Loading picture…" : this._phase === "failed" ? "No picture right now" : "No picture yet";
    return html`<div class="frame">
      ${this._url
        ? html`<img src=${this._url} alt=${this.alt} decoding="async">`
        : html`<div class="empty"><ha-icon .icon=${this._phase === "loading" ? "mdi:image-outline" : "mdi:image-off-outline"} aria-hidden="true"></ha-icon><span>${label}</span></div>`}
      ${stale ? html`<span class="age">${ageText(this._takenAt as number)}</span>` : nothing}
    </div>`;
  }
}

customElements.define("kestrel-live-picture", KestrelLivePicture);

declare global { interface HTMLElementTagNameMap { "kestrel-live-picture": KestrelLivePicture; } }
