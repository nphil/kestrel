import { BASE_CSS, renderIcon } from "lucent-ha";
import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { boxLabel, boxesAt, containRect, hitRect, placeLabel, toPixels, type Rect } from "../detections.ts";
import type { VisitDetections } from "../types.ts";

/** Whether the person wants the boxes. Remembered for every visit page and every time the panel is opened; off until they turn it on. */
const STORE_KEY = "kestrel.detection-boxes";
const TOGGLE_NAME = "Show detection boxes";
/** How many boxes are drawn at once: a visit is one animal, sometimes two. */
const SLOTS = 4;
/** After these the picture may have another shape, place or moment: draw again. */
const CHANGES = ["loadedmetadata", "resize", "emptied", "seeked", "play"];

function wasOn(): boolean {
  try { return window.localStorage.getItem(STORE_KEY) === "1"; } catch { return false; }
}

function remember(on: boolean): void {
  try { window.localStorage.setItem(STORE_KEY, on ? "1" : "0"); } catch { /* storage blocked: the choice still holds until the page is closed */ }
}

/** Moves `el` to `r` with a transform, the cheap way to move something every frame; the size only when asked. */
function place(el: HTMLElement, r: Rect, sized: boolean): void {
  el.style.transform = `translate(${r.x.toFixed(1)}px,${r.y.toFixed(1)}px)`;
  if (sized) { el.style.width = `${r.w.toFixed(1)}px`; el.style.height = `${r.h.toFixed(1)}px`; }
}

/** Draws the boxes of `data` into `layer`, over `video`, in step with the picture the video shows, until the returned function is called (which takes every
 * listener, observer and pending callback away again). Each box is three plain elements whose position and size are written directly for every video frame,
 * so nothing is rendered by Lit while it plays: the box, its label above it, and the invisible part of both that takes a tap (`onTap`), which stops short of
 * the strip where the browser draws its controls. Labels keep clear of `toggle`, the on/off button in the corner. Nothing is drawn, and nothing is waited for,
 * while the tab or the video is out of sight. */
function drawBoxes(video: HTMLVideoElement, layer: HTMLElement, toggle: HTMLElement, data: VisitDetections, onTap: () => void): () => void {
  const make = (name: string): HTMLElement[] => Array.from({ length: SLOTS }, () => Object.assign(document.createElement("div"), { className: name, hidden: true }));
  const [boxes, tags, hits] = [make("box"), make("tag"), make("hit")];
  layer.append(...boxes, ...tags, ...hits);
  /** What each label said and measured the last time: the layout is read again only when its words change. */
  const labels = boxes.map(() => ({ text: "", w: 0, h: 0 }));
  const still = window.matchMedia("(prefers-reduced-motion: reduce)");
  const hasFrameCallback = typeof video.requestVideoFrameCallback === "function";
  let size = { w: video.clientWidth, h: video.clientHeight };
  let picture: Rect | null = null;
  let waiting = 0; // the next-frame callback that is pending, 0 for none
  let onScreen = true;
  let corner: Rect | null = null; // where the toggle is, a little larger than it is: a label does not go under it

  const paint = (seconds: number): void => {
    const where = picture;
    const found = where ? boxesAt(data, seconds * 1000, { interpolate: !still.matches }) : [];
    boxes.forEach((box, i) => {
      const one = found[i];
      box.hidden = tags[i].hidden = !where || !one;
      if (!where || !one) { hits[i].hidden = true; return; }
      const label = labels[i];
      const text = boxLabel(one);
      if (text !== label.text) {
        tags[i].textContent = label.text = text;
        label.w = tags[i].offsetWidth;
        label.h = tags[i].offsetHeight;
        if (!label.w) label.text = ""; // not laid out yet: measure again next time
      }
      const at = toPixels(one, where);
      const tag = { ...placeLabel(at, label.w, label.h, where, corner), w: label.w, h: label.h };
      const tap = hitRect(at, tag, size);
      hits[i].hidden = !tap;
      place(box, at, true);
      place(tags[i], { ...tag, x: Math.round(tag.x), y: Math.round(tag.y) }, false);
      if (tap) place(hits[i], tap, true);
    });
  };

  /** Asks for the next picture: the browser says when a video frame is on screen and which moment of the video it is (`mediaTime`, exact, unlike `currentTime`).
   * Without that, a browser's own animation frames are used while the video plays. */
  const arm = (): void => {
    if (waiting || document.hidden || !onScreen) return;
    if (hasFrameCallback) waiting = video.requestVideoFrameCallback((_now, frame) => { waiting = 0; paint(frame.mediaTime); arm(); });
    else if (!video.paused) waiting = requestAnimationFrame(() => { waiting = 0; paint(video.currentTime); arm(); });
  };

  const disarm = (): void => {
    if (hasFrameCallback) video.cancelVideoFrameCallback(waiting);
    else cancelAnimationFrame(waiting);
    waiting = 0;
  };

  const measureCorner = (): void => {
    const button = toggle.getBoundingClientRect();
    const area = layer.getBoundingClientRect();
    corner = { x: button.left - area.left - 4, y: button.top - area.top - 4, w: button.width + 8, h: button.height + 8 };
  };

  /** The picture may have moved or changed shape, or the video was put at another moment (paused, seeked): look again and draw what is on screen now. */
  const settle = (): void => {
    if (document.hidden || !onScreen) return; // coming back into sight settles again
    picture = containRect(size.w, size.h, video.videoWidth, video.videoHeight);
    paint(video.currentTime);
    arm();
  };

  const events = hasFrameCallback ? CHANGES : [...CHANGES, "pause", "timeupdate"];
  for (const name of events) video.addEventListener(name, settle);
  const resized = new ResizeObserver((entries) => {
    const { width, height } = entries[entries.length - 1].contentRect;
    size = { w: width, h: height };
    measureCorner();
    for (const label of labels) label.text = ""; // a narrower picture may cut a label short
    settle();
  });
  const visible = new IntersectionObserver((entries) => {
    onScreen = entries[entries.length - 1].isIntersecting;
    if (onScreen) settle();
    else disarm();
  });
  const shown = (): void => { if (document.hidden) disarm(); else settle(); };
  resized.observe(video);
  visible.observe(video);
  document.addEventListener("visibilitychange", shown);
  layer.addEventListener("click", onTap);
  measureCorner();
  settle();

  return () => {
    disarm();
    resized.disconnect();
    visible.disconnect();
    document.removeEventListener("visibilitychange", shown);
    for (const name of events) video.removeEventListener(name, settle);
    layer.removeEventListener("click", onTap);
    layer.replaceChildren();
  };
}

/** The clip of a visit with an on/off switch for what the detector saw: put the `<video>` inside it. With a `detections` track (and only then) a round button at
 * the video's top right turns the boxes on and off; while they are on, a box follows each animal through the clip with its name, and pressing a box fires
 * `box-tap`, so the page can ask what the animal really was. The boxes are decoration for a screen reader (the page has a "Wrong?" button), the switch is a real
 * button: of its own, because the toolkit's button has no pressed state, in the toolkit's look for controls over a picture (the `--lu-reading` surface, the press
 * and hover washes). The boxes are laid over the video and take no press except on a box, so the video's own controls and a press on the empty picture work as before. */
export class KestrelDetectionBoxes extends LitElement {
  static properties = {
    detections: { attribute: false },
    _on: { state: true },
  };

  declare detections: VisitDetections | undefined;
  declare _on: boolean;

  private _end?: () => void;

  constructor() {
    super();
    this.detections = undefined;
    this._on = wasOn();
  }

  connectedCallback(): void {
    super.connectedCallback();
    this._sync();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this._end?.();
    this._end = undefined;
  }

  protected updated(changed: PropertyValues<this>): void {
    if (changed.has("detections") || changed.has("_on")) this._sync();
  }

  /** Starts drawing (again) when everything it needs is there, and stops when it is not: boxes on, a track, a video, and the page still showing it. */
  private _sync(): void {
    this._end?.();
    this._end = undefined;
    const video = this.querySelector("video");
    const layer = this.renderRoot.querySelector<HTMLElement>(".layer");
    const toggle = this.renderRoot.querySelector<HTMLElement>(".toggle");
    if (this.isConnected && video && layer && toggle && this.detections?.frames.length) {
      this._end = drawBoxes(video, layer, toggle, this.detections, () => this.dispatchEvent(new CustomEvent("box-tap", { bubbles: true, composed: true })));
    }
  }

  private _toggle(): void {
    this._on = !this._on;
    remember(this._on);
  }

  static styles = [BASE_CSS, css`
    :host { position: relative; display: block; }
    [hidden] { display: none !important; }
    /* Over the video and nothing else: it takes no press itself (the video's controls and a press on the empty picture work as before); only the .hit parts do. */
    .layer { position: absolute; inset: 0; overflow: hidden; border-radius: var(--lu-radius-tile); pointer-events: none; contain: strict; }
    .box, .tag, .hit { position: absolute; left: 0; top: 0; }
    /* The line is the theme's accent with a thin ring of the page colour on both sides, so one of the two stands out from night footage and from bright daylight alike. */
    .box { border: 2px solid var(--lu-accent); border-radius: var(--lu-space-1); box-shadow: 0 0 0 1px var(--lu-reading), inset 0 0 0 1px var(--lu-reading); }
    .tag { max-width: 100%; padding: 0 var(--lu-space-2); overflow: hidden; border: 1px solid var(--lu-accent); border-radius: var(--lu-radius-pill); color: var(--lu-ink); background: var(--lu-reading); font: 600 var(--lu-type-caption)/20px var(--lu-font); white-space: nowrap; text-overflow: ellipsis; }
    .hit { pointer-events: auto; cursor: pointer; touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
    .toggle { position: absolute; top: var(--lu-space-2); right: var(--lu-space-2); display: grid; width: var(--lu-target); height: var(--lu-target); place-items: center; padding: 0; border: 1px solid var(--lu-edge-raised); border-radius: 50%; color: var(--lu-ink); background: var(--lu-reading); box-shadow: var(--lu-highlight-rest); cursor: pointer; transition: background-color var(--lu-motion-label) var(--lu-ease); -webkit-tap-highlight-color: transparent; }
    .toggle[aria-pressed="true"] { border-color: var(--lu-accent); color: var(--lu-accent-ink); background: var(--lu-accent); }
    @supports (color: contrast-color(red)) { .toggle[aria-pressed="true"] { color: contrast-color(var(--lu-accent)); } }
    .toggle:is(:active, [data-pressed]) { background-image: linear-gradient(var(--lu-material-press-wash), var(--lu-material-press-wash)); transition: none; }
    @media (hover: hover) and (pointer: fine) { .toggle:hover { background-image: linear-gradient(var(--lu-material-hover-wash), var(--lu-material-hover-wash)); } }
    @media (prefers-reduced-motion: reduce) { .toggle { transition: none; } }
  `];

  render() {
    const tracked = Boolean(this.detections?.frames.length);
    return html`<slot @slotchange=${this._sync}></slot>
      ${tracked && this._on ? html`<div class="layer" aria-hidden="true"></div>` : nothing}
      ${tracked ? html`<button class="toggle" type="button" aria-pressed=${this._on ? "true" : "false"} aria-label=${TOGGLE_NAME} title=${TOGGLE_NAME} @click=${this._toggle}>${renderIcon("mdi:select")}</button>` : nothing}`;
  }
}

customElements.define("kestrel-detection-boxes", KestrelDetectionBoxes);

declare global { interface HTMLElementTagNameMap { "kestrel-detection-boxes": KestrelDetectionBoxes; } }
