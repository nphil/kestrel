import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { BASE_CSS, CONTROLS_CSS } from "../styles/tokens.ts";
import { claimAudio, releaseAudio } from "./audio-focus.ts";

export interface AudioRow {
  id: string;
  /** Where the recording plays from; null means there is nothing to play. */
  src: string | null;
  /** Main line, e.g. when it was recorded. */
  title: string;
  /** Quieter line, e.g. where. */
  caption?: string;
  /** Short value at the end of the row, e.g. a confidence. */
  meta?: string;
  /** Small passive label after the title, e.g. "Cleaned". */
  mark?: string;
  /** Played instead when `src` can't be loaded, e.g. the untouched recording behind a cleaned preview. */
  fallback?: string | null;
  /** Full accessible name of the play button's subject ("recording from 4:45 AM at Backyard"). */
  label: string;
}

/** A list of recordings, each with a play button that plays right in the row. One shared audio element, and
 * `claimAudio`, mean only one recording plays at a time, anywhere in the panel. Pressing play starts the
 * download a moment before the tap completes. Tapping the rest of a row fires `select` ({ id }); the
 * trailing button fires `more`.
 *
 * Needs the host's `--lu-*` tokens. */
export class KestrelAudioList extends LitElement {
  static properties = {
    rows: { attribute: false },
    more: { type: Boolean },
    loading: { type: Boolean },
    moreLabel: { type: String, attribute: "more-label" },
    _active: { state: true },
    _playing: { state: true },
    _failed: { state: true },
  };

  declare rows: AudioRow[];
  declare more: boolean;
  declare loading: boolean;
  declare moreLabel: string;
  declare _active: string | null;
  declare _playing: boolean;
  declare _failed: Set<string>;

  private _warmed = "";
  private _warmedFirst = false;

  constructor() {
    super();
    this.rows = [];
    this.more = false;
    this.loading = false;
    this.moreLabel = "Show more recordings";
    this._active = null;
    this._playing = false;
    this._failed = new Set();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    const audio = this._audio;
    if (audio) {
      releaseAudio(audio);
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
  }

  protected updated(changed: PropertyValues<this>): void {
    if (changed.has("rows") && this._active && !this.rows.some((row) => row.id === this._active)) this.stop();
    // The newest recording is the one most likely to be played first: have it ready when the list appears.
    if (changed.has("rows") && !this._warmedFirst) {
      const first = this.rows.find((row) => row.src);
      if (first) { this._warmedFirst = true; this._warm(first); }
    }
  }

  private get _audio(): HTMLAudioElement | null { return this.renderRoot.querySelector("audio"); }

  /** Stops whatever is playing. */
  stop(): void {
    const audio = this._audio;
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
    }
    this._warmed = "";
    this._active = null;
    this._playing = false;
  }

  /** Begins loading a recording on press, while nothing else is playing, so the tap that follows starts it sooner. */
  private _warm(row: AudioRow): void {
    const audio = this._audio;
    if (!audio || !row.src || this._active === row.id || this._warmed === row.id || !audio.paused) return;
    this._warmed = row.id;
    audio.src = row.src;
    audio.preload = "auto";
    audio.load();
  }

  private _toggle(row: AudioRow): void {
    const audio = this._audio;
    if (!audio || !row.src) return;
    if (this._active === row.id) {
      if (audio.paused) void audio.play().catch(() => undefined);
      else audio.pause();
      return;
    }
    if (this._failed.has(row.id)) { const next = new Set(this._failed); next.delete(row.id); this._failed = next; this._warmed = ""; }
    this._active = row.id;
    this._playing = false;
    // The row's source can change while it is listed (a cleaner preview became ready): always play the current one.
    if (this._warmed !== row.id || audio.getAttribute("src") !== row.src) { audio.src = row.src; this._warmed = row.id; }
    void audio.play().catch(() => undefined); // a failed load raises `error` on the element
  }

  private _onPlay(event: Event): void { claimAudio(event.currentTarget as HTMLAudioElement); this._playing = true; }
  private _onPause(event: Event): void { releaseAudio(event.currentTarget as HTMLAudioElement); this._playing = false; }

  private _onEnded(event: Event): void {
    releaseAudio(event.currentTarget as HTMLAudioElement);
    this._playing = false;
    this._active = null;
    this._warmed = "";
  }

  /** Moves the active row's hairline without re-rendering the whole list four times a second. */
  private _onTime(event: Event): void {
    const audio = event.currentTarget as HTMLAudioElement;
    const bar = this.renderRoot.querySelector<HTMLElement>(".progress");
    if (bar && audio.duration > 0) bar.style.transform = `scaleX(${Math.min(1, audio.currentTime / audio.duration)})`;
  }

  private _onError(): void {
    const audio = this._audio;
    const row = this.rows.find((candidate) => candidate.id === (this._active ?? this._warmed));
    if (audio && row?.fallback && audio.getAttribute("src") !== row.fallback) {
      audio.src = row.fallback;
      if (this._active === row.id) void audio.play().catch(() => undefined);
      return;
    }
    const id = this._active ?? this._warmed;
    if (id) this._failed = new Set(this._failed).add(id);
    this._active = null;
    this._playing = false;
    this._warmed = "";
  }

  static styles = [BASE_CSS, CONTROLS_CSS, css`
    :host { display: block; }
    ul { margin: 0; padding: 0; list-style: none; }
    li { position: relative; display: flex; align-items: center; gap: var(--lu-space-2); height: var(--lu-row); border-bottom: 1px solid var(--lu-edge); content-visibility: auto; contain-intrinsic-size: auto var(--lu-row); }
    li:last-child { border-bottom: 0; }
    .play { display: grid; flex: none; width: var(--lu-target); height: var(--lu-target); place-items: center; padding: 0; border: 1px solid var(--lu-edge-raised); border-radius: 50%; color: var(--lu-ink); background: var(--lu-glass-raised); box-shadow: var(--lu-highlight-raised); cursor: pointer; transition: transform var(--lu-motion-press) var(--lu-ease-press), background-color var(--lu-motion-label) var(--lu-ease); }
    .play:is(:active, [data-pressed]):not(:disabled) { transform: scale(var(--lu-scale-pressed)); background-image: linear-gradient(var(--lu-material-press-wash), var(--lu-material-press-wash)); }
    .active .play { border-color: transparent; color: var(--lu-accent-ink); background: var(--lu-accent); box-shadow: none; }
    .play:disabled { color: var(--lu-ink-3); background: var(--lu-tile); box-shadow: none; cursor: not-allowed; }
    .play ha-icon { --mdc-icon-size: 24px; width: 24px; height: 24px; }
    .open { display: flex; flex: 1; align-items: center; gap: var(--lu-space-3); min-width: 0; height: 100%; padding: 0 var(--lu-space-2) 0 var(--lu-space-3); border: 0; border-radius: var(--lu-radius-row); color: var(--lu-ink); background: transparent; text-align: left; cursor: pointer; transition: background-color var(--lu-motion-label) var(--lu-ease); }
    .open:is(:active, [data-pressed]) { background: var(--lu-material-press-wash); }
    @media (hover: hover) and (pointer: fine) { .open:hover { background: var(--lu-material-hover-wash); } }
    .open > ha-icon { flex: none; color: var(--lu-ink-3); }
    .text { display: flex; flex: 1; flex-direction: column; gap: 2px; min-width: 0; }
    .title { overflow: hidden; font-size: var(--lu-type-label); font-weight: 550; text-overflow: ellipsis; white-space: nowrap; }
    .mark { margin-left: var(--lu-space-2); padding: 1px var(--lu-space-2); border: 1px solid var(--lu-edge); border-radius: var(--lu-radius-pill); color: var(--lu-ink-2); font-size: var(--lu-type-caption); font-weight: 600; vertical-align: 1px; }
    .caption { overflow: hidden; color: var(--lu-ink-2); font-size: var(--lu-type-caption); text-overflow: ellipsis; white-space: nowrap; }
    .caption.failed { color: var(--lu-danger); }
    .meta { color: var(--lu-ink-2); font-size: var(--lu-type-label); font-variant-numeric: tabular-nums; }
    .progress { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; background: var(--lu-accent); transform: scaleX(0); transform-origin: left; transition: transform 250ms linear; }
    @media (prefers-reduced-motion: reduce) { .progress { transition: none; } }
  `];

  render() {
    return html`<ul role="list">
      ${this.rows.map((row) => {
        const active = this._active === row.id;
        const playing = active && this._playing;
        const failed = this._failed.has(row.id);
        const note = failed ? "Couldn't load this recording." : !row.src ? "No recording saved" : row.caption ?? "";
        return html`<li class=${active ? "active" : ""}>
          <button class="play" type="button" ?disabled=${!row.src} aria-label=${`${playing ? "Pause" : "Play"} ${row.label}`} @pointerdown=${() => this._warm(row)} @click=${() => this._toggle(row)}><ha-icon .icon=${!row.src ? "mdi:volume-off" : playing ? "mdi:pause" : "mdi:play"} aria-hidden="true"></ha-icon></button>
          <button class="open" type="button" aria-label=${`Open ${row.label}`} @click=${() => this.dispatchEvent(new CustomEvent("select", { detail: { id: row.id } }))}>
            <span class="text"><span class="title">${row.title}${row.mark ? html`<span class="mark">${row.mark}</span>` : nothing}</span>${note ? html`<span class=${failed ? "caption failed" : "caption"}>${note}</span>` : nothing}</span>
            ${row.meta ? html`<span class="meta">${row.meta}</span>` : nothing}
            <ha-icon .icon=${"mdi:chevron-right"} aria-hidden="true"></ha-icon>
          </button>
          ${active ? html`<span class="progress" aria-hidden="true"></span>` : nothing}
        </li>`;
      })}
    </ul>
    ${this.more ? html`<button class="text-button" type="button" ?disabled=${this.loading} @click=${() => this.dispatchEvent(new CustomEvent("more"))}>${this.loading ? "Loading…" : this.moreLabel}</button>` : nothing}
    <audio hidden preload="none" @play=${this._onPlay} @pause=${this._onPause} @ended=${this._onEnded} @timeupdate=${this._onTime} @error=${this._onError}></audio>`;
  }
}

customElements.define("kestrel-audio-list", KestrelAudioList);

declare global { interface HTMLElementTagNameMap { "kestrel-audio-list": KestrelAudioList; } }
