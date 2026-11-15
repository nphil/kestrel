import { InViewController, LuAudioList, SharedAudio, emit, renderIcon, type AudioListRow } from "lucent-ha";
import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { api } from "../api.ts";
import { knownExtras, loadExtras } from "../recordings.ts";
import type { HomeAssistant } from "../types.ts";
import { WEATHER_CSS, weatherLine } from "../ui/weather.ts";
import "./kestrel-spectrogram.ts";

/** The toolkit's list of recordings (one speaker for the whole list, a play button in every row, only one sound at a time on the page), with what
 * Kestrel knows about each recording under it: the weather at the time and a spectrogram. It is the toolkit's `lu-audio-list` in everything it
 * does, so `rows`, `more`, `loading`, `more-label`, `lu-select {id}` and `lu-more` are the same; the one addition is `hass`, which is how it asks
 * for those two things (once the list is near the screen, for the rows that have a recording, and only for what it has not been told yet).
 *
 * A row's strip is held open while the answer is on its way, and closes if the answer has nothing for it, so a list does not jump about as it fills. */
export class KestrelRecordingList extends LitElement {
  static properties = {
    rows: { attribute: false },
    more: { type: Boolean },
    loading: { type: Boolean },
    moreLabel: { type: String, attribute: "more-label" },
  };

  declare rows: readonly AudioListRow[];
  declare more: boolean;
  declare loading: boolean;
  declare moreLabel: string;

  /** Not reactive: the list does not redraw when Home Assistant's state changes. */
  hass: HomeAssistant | undefined;

  private _shared: SharedAudio | undefined;
  /** Rows whose answer has come (or failed), so the placeholder strip stays only while it is really on its way. */
  private readonly _answered = new Set<string>();
  private readonly _view = new InViewController(this, { rootMargin: "300px", onChange: (visible) => { if (visible) void this._askExtras(); } });

  constructor() {
    super();
    this.rows = [];
    this.more = false;
    this.loading = false;
    this.moreLabel = "Show more recordings";
  }

  connectedCallback(): void {
    super.connectedCallback();
    if (this._shared) this._shared.setRows(this.rows); // came back after a removal: warm the newest row again
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this._shared?.dispose();
  }

  protected firstUpdated(): void {
    const audio = this.renderRoot.querySelector("audio");
    if (!audio) return;
    this._shared = new SharedAudio(audio, {
      changed: () => this.requestUpdate(),
      progress: (fraction) => {
        const bar = this.renderRoot.querySelector<HTMLElement>(".progress");
        if (bar) bar.style.transform = `scaleX(${fraction})`;
      },
    });
  }

  protected updated(changed: PropertyValues<this>): void {
    if (!changed.has("rows")) return;
    this._shared?.setRows(this.rows);
    void this._askExtras();
  }

  /** Stops whatever is playing. */
  stop(): void {
    this._shared?.stop();
  }

  private async _askExtras(): Promise<void> {
    const hass = this.hass;
    if (!hass || !this._view.visible) return;
    const ids = this.rows.filter((row) => row.src && knownExtras(row.id) === undefined).map((row) => row.id);
    if (!ids.length) return;
    await loadExtras((batch) => api.recordings(hass, batch), ids);
    for (const id of ids) this._answered.add(id);
    this.requestUpdate();
  }

  static styles = [...LuAudioList.styles, WEATHER_CSS, css`
    li { display: block; height: auto; contain-intrinsic-size: auto calc(var(--lu-row) + 72px); }
    .line { position: relative; display: flex; align-items: center; gap: var(--lu-space-2); height: var(--lu-row); }
    .extras { display: grid; gap: var(--lu-space-1); padding: 0 0 var(--lu-space-3); }
    .extras .weather { padding-left: calc(var(--lu-target) + var(--lu-space-2) + var(--lu-space-3)); }
  `];

  protected render() {
    const shared = this._shared;
    return html`<ul role="list">
      ${this.rows.map((row) => {
        const active = shared?.isActive(row) ?? false;
        const playing = shared?.isPlaying(row) ?? false;
        const failed = shared?.isFailed(row) ?? false;
        const note = failed ? "Couldn't load this recording." : !row.src ? "No recording saved" : row.caption ?? "";
        const extras = knownExtras(row.id);
        const waiting = Boolean(row.src) && !extras && !this._answered.has(row.id);
        return html`<li class=${active ? "active" : ""}>
          <div class="line">
            <button class="play" type="button" ?disabled=${!row.src} aria-label=${`${playing ? "Pause" : "Play"} ${row.label}`} @pointerdown=${() => this._shared?.warm(row)} @click=${() => this._shared?.toggle(row)}>${renderIcon(!row.src ? "mdi:volume-off" : playing ? "mdi:pause" : "mdi:play")}</button>
            <button class="open" type="button" aria-label=${`Open ${row.label}`} @click=${() => emit(this, "lu-select", { id: row.id })}>
              <span class="text"><span class="title">${row.title}${row.mark ? html`<span class="mark">${row.mark}</span>` : nothing}</span>${note ? html`<span class=${failed ? "note failed" : "note"}>${note}</span>` : nothing}</span>
              ${row.meta ? html`<span class="meta">${row.meta}</span>` : nothing}
              ${renderIcon("mdi:chevron-right")}
            </button>
            ${active ? html`<span class="progress" aria-hidden="true"></span>` : nothing}
          </div>
          ${row.src && (waiting || extras?.weather || extras?.spectrogram) ? html`<div class="extras">
            ${extras?.weather ? weatherLine(extras.weather) : nothing}
            <kestrel-spectrogram .src=${extras?.spectrogram ?? ""} ?pending=${waiting} .follows=${[row.src, row.fallback ?? ""]} .label=${row.label}></kestrel-spectrogram>
          </div>` : nothing}
        </li>`;
      })}
    </ul>
    ${this.more ? html`<button class="text-button" type="button" ?disabled=${this.loading} @click=${() => emit(this, "lu-more")}>${this.loading ? "Loading…" : this.moreLabel}</button>` : nothing}
    <audio hidden preload="none" @play=${() => this._shared?.handlePlay()} @pause=${() => this._shared?.handlePause()} @ended=${() => this._shared?.handleEnded()} @timeupdate=${() => this._shared?.handleTime()} @error=${() => this._shared?.handleError()}></audio>`;
  }
}

customElements.define("kestrel-recording-list", KestrelRecordingList);

declare global { interface HTMLElementTagNameMap { "kestrel-recording-list": KestrelRecordingList; } }
