import { BASE_CSS, renderIcon, type AudioListRow, type LuCloseDetail, type RailItem } from "lucent-ha";
import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { api, loadPhotoCredit, speciesPicture, visitAudio, visitAudioOriginal, visitPage, visitSnapshot } from "../api.ts";
import { DEFAULT_CREDIT, dayBars, dayCaption, dayChartLabel, factRows, newChip, speciesFacts, type FactRow, type SpeciesFacts } from "../facts.ts";
import { pluralize, sentence, timestamp, when } from "../format.ts";
import { forgetExtras } from "../recordings.ts";
import type { Camera, HomeAssistant, PhotoCredit, Species, Visit, VisitKind } from "../types.ts";
import { pathOf, sameMedia } from "../urls.ts";
import { BARS_CSS, barChart } from "../ui/bars.ts";
import { descriptionCredit } from "../ui/description-credit.ts";
import { HEARD_HERO_CSS, heardHero } from "../ui/heard-hero.ts";
import { photoCaption } from "../ui/photo-credit.ts";
import { GROUP_LABEL, KIND, evidenceWord, recordingNotes, tierWord, visitConfidence } from "../vocab.ts";
import "./kestrel-recording-list.ts";
import "./kestrel-reference-sound.ts";

interface Section { items: Visit[]; next: string | null; state: "loading" | "ready" | "error" }
type Sections = Record<VisitKind, Section>;

/** First page, and every page after it. A species with 399 recordings and 1 video must still show its
 * video, so the two lists are fetched separately, each with its own paging cursor. */
const FIRST: Record<VisitKind, number> = { seen: 12, heard: 10 };
const MORE: Record<VisitKind, number> = { seen: 12, heard: 20 };
/** Most rows kept per section, so the sheet stays light. */
const CAP = 100;
const TITLE: Record<VisitKind, string> = { seen: "On camera", heard: "Heard" };
const NOUN: Record<VisitKind, [string, string]> = { seen: ["video", "videos"], heard: ["recording", "recordings"] };
const EMPTY: Record<VisitKind, string> = { seen: "Not seen on camera yet", heard: "Not heard yet" };
const KINDS: VisitKind[] = ["seen", "heard"];

/** Sections seen this session, so reopening a species (or coming back to it with Back) shows its lists at
 * once and refreshes them behind the scenes. Signed media links last 12 hours; this keeps them for 30 minutes. */
const CACHE = new Map<string, { at: number; sections: Sections }>();
const CACHE_MAX = 12;
const CACHE_TTL_MS = 30 * 60_000;

/** What the sheet's own answer adds to the list's fields (`speciesFacts`: the days, first and last, the surest ID, the description), kept the same way. */
const FACTS = new Map<string, { at: number; facts: SpeciesFacts }>();

const fresh = (): Sections => ({ seen: { items: [], next: null, state: "loading" }, heard: { items: [], next: null, state: "loading" } });
const startedMs = (visit: Visit): number => timestamp(visit.startedAt) ?? 0;

/** Drops a visit that no longer exists from every remembered species. */
export function forgetVisit(id: string): void {
  for (const entry of CACHE.values()) {
    for (const kind of KINDS) entry.sections[kind] = { ...entry.sections[kind], items: entry.sections[kind].items.filter((visit) => visit.id !== id) };
  }
}

/** Forgets every remembered species: their pictures and recordings carry links Home Assistant signed with a key it has since replaced, and so do the spectrograms asked for under them. */
export function forgetSheetCache(): void {
  CACHE.clear();
  FACTS.clear();
  forgetExtras();
}

function remember(name: string, sections: Sections): void {
  CACHE.delete(name);
  CACHE.set(name, { at: Date.now(), sections });
  while (CACHE.size > CACHE_MAX) CACHE.delete(CACHE.keys().next().value as string);
}

/** A species' evidence: what the cameras caught and what the microphone heard, each in its own section.
 * Kestrel glue over the toolkit's sheet, section, rail and audio list. `open` shows it; the owner keeps the element
 * (and `species`) until `close` arrives, which is after the exit motion. Fires `close` ({ reason }), `open-visit`
 * ({ id, visit }), `warm-visit` ({ id }) and `toggle-mute`. The sheet adds no history entry: the address (`?s=`)
 * is the history. */
export class KestrelSpeciesSheet extends LitElement {
  static properties = {
    hass: { attribute: false },
    species: { attribute: false },
    cameras: { attribute: false },
    open: { type: Boolean },
    muted: { type: Boolean },
    canMute: { type: Boolean, attribute: "can-mute" },
    _sections: { state: true },
    _photoFailed: { state: true },
    _credit: { state: true },
    _facts: { state: true },
  };

  declare hass: HomeAssistant | undefined;
  declare species: Species | undefined;
  declare cameras: Camera[];
  declare open: boolean;
  declare muted: boolean;
  declare canMute: boolean;
  declare _sections: Sections;
  declare _photoFailed: boolean;
  declare _credit: PhotoCredit | null;
  declare _facts: SpeciesFacts | null;

  private _loadedFor = "";
  private _requests: Record<VisitKind, number> = { seen: 0, heard: 0 };
  private _creditKey = "";
  private _factsRequest = 0;
  private _rail: RailItem[] = [];
  private _rows: AudioListRow[] = [];

  constructor() {
    super();
    this.cameras = [];
    this.open = false;
    this.muted = false;
    this.canMute = false;
    this._sections = fresh();
    this._photoFailed = false;
    this._credit = null;
    this._facts = null;
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this._factsRequest += 1;
    this._requests = { seen: this._requests.seen + 1, heard: this._requests.heard + 1 };
    if (this._loadedFor) remember(this._loadedFor, this._sections);
  }

  protected willUpdate(_changed: PropertyValues<this>): void {
    // Who took the reference photo: asked once per photo; an answer that arrives after the species changed finds another key and is ignored.
    const infoUrl = this.species && speciesPicture(this.species).isReference ? this.species.referenceImageInfoUrl : null;
    const key = infoUrl ? pathOf(infoUrl) : "";
    if (key !== this._creditKey) {
      this._creditKey = key;
      this._credit = null;
      if (infoUrl) void loadPhotoCredit(infoUrl).then((credit) => { if (key === this._creditKey) this._credit = credit; });
    }
    const name = this.species?.species ?? "";
    if (!name || name === this._loadedFor) return;
    this._loadedFor = name;
    this._photoFailed = false;
    const known = FACTS.get(name);
    this._facts = known && Date.now() - known.at < CACHE_TTL_MS ? known.facts : null;
    const cached = CACHE.get(name);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) this._setSections(cached.sections);
    else this._setSections(fresh());
  }

  protected updated(): void {
    const name = this.species?.species ?? "";
    if (!this.hass || !name || this._started === name) return;
    this._started = name;
    for (const kind of KINDS) void this._load(kind, false);
    void this._loadFacts();
  }

  private _started = "";

  private _setSections(sections: Sections): void {
    this._sections = sections;
    this._rail = sections.seen.items.map((visit) => this._railItem(visit));
    this._rows = sections.heard.items.map((visit) => this._audioRow(visit));
  }

  private _railItem(visit: Visit): RailItem {
    const time = sentence(when(visit.startedAt));
    const word = evidenceWord(visit);
    const video = word === KIND.seen.word;
    return {
      id: visit.id,
      image: visitSnapshot(visit) ?? "",
      title: time,
      caption: visit.camera.name,
      label: `${word} from ${time.toLowerCase()} at ${visit.camera.name}`,
      play: video,
      ...(video ? {} : { badge: word, badgeIcon: KIND.seen.icon }),
    };
  }

  private _audioRow(visit: Visit): AudioListRow {
    const time = sentence(when(visit.startedAt));
    const sure = visitConfidence(visit);
    const score = sure === undefined ? undefined : `${Math.round(sure * 100)}%`;
    const tier = tierWord(visit);
    const mark = [tier === "Likely" ? "" : tier, recordingNotes(visit.audioInfo).mark].filter(Boolean).join(" · ");
    const src = visitAudio(visit);
    const original = visitAudioOriginal(visit);
    return { id: visit.id, src, ...(original && !sameMedia(original, src) ? { fallback: original } : {}), title: time, caption: visit.camera.name, ...(score ? { meta: score } : {}), ...(mark ? { mark } : {}), label: `recording from ${time.toLowerCase()} at ${visit.camera.name}${mark ? `, ${mark.toLowerCase()}` : ""}` };
  }

  /** Takes a deleted visit out of the lists at once. */
  forget(id: string): void {
    const next: Sections = { seen: { ...this._sections.seen }, heard: { ...this._sections.heard } };
    let changed = false;
    for (const kind of KINDS) {
      const items = next[kind].items.filter((visit) => visit.id !== id);
      if (items.length !== next[kind].items.length) { next[kind] = { ...next[kind], items }; changed = true; }
    }
    if (changed) this._setSections(next);
  }

  /** Brings in anything newer than what is listed, e.g. after a push event. A visit can change species while
   * it is being identified, so the newest page replaces what it overlaps instead of only adding to it.
   * Resolves to false when a list could not be fetched. */
  async refresh(): Promise<boolean> {
    void this._loadFacts();
    const results = await Promise.all(KINDS.map((kind) => this._load(kind, false)));
    return results.every(Boolean);
  }

  /** Starts both lists again from their first page. Used when every link they hold is dead (Home Assistant restarted):
   * rows that were paged in later cannot be repaired one by one. Resolves to false when a list could not be fetched. */
  async reload(): Promise<boolean> {
    if (!this._loadedFor) return true;
    this._requests = { seen: this._requests.seen + 1, heard: this._requests.heard + 1 };
    this._setSections(fresh());
    void this._loadFacts();
    const results = await Promise.all(KINDS.map((kind) => this._load(kind, false)));
    return results.every(Boolean);
  }

  private async _load(kind: VisitKind, more: boolean): Promise<boolean> {
    const hass = this.hass;
    const name = this.species?.species;
    const section = this._sections[kind];
    const before = more ? section.next : null;
    if (!hass || !name || (more && !before)) return true;
    const request = ++this._requests[kind];
    const background = !more && section.items.length > 0; // already showing something: don't blank it
    if (!background) this._setSections({ ...this._sections, [kind]: { ...section, state: "loading" } });
    try {
      const page = visitPage(await api.visits(hass, { species: name, kind, limit: more ? MORE[kind] : FIRST[kind], ...(before ? { before } : {}) }));
      if (request !== this._requests[kind] || name !== this.species?.species) return true;
      const incoming = page.items.filter((visit) => visit.kind === kind);
      const current = this._sections[kind].items;
      let items: Visit[];
      let next: string | null;
      if (more) {
        const known = new Set(current.map((visit) => visit.id));
        items = [...current, ...incoming.filter((visit) => !known.has(visit.id))];
        next = page.next ?? null;
      } else if (page.next === null || page.next === undefined) {
        items = incoming; // the whole list fit on one page
        next = null;
      } else {
        const oldest = startedMs(incoming[incoming.length - 1]);
        const shown = new Set(incoming.map((visit) => visit.id));
        items = [...incoming, ...current.filter((visit) => !shown.has(visit.id) && startedMs(visit) < oldest)];
        next = current.length > incoming.length ? this._sections[kind].next : page.next;
      }
      items = items.slice(0, CAP);
      this._setSections({ ...this._sections, [kind]: { items, next: items.length < CAP ? next : null, state: "ready" } });
      return true;
    } catch {
      if (request === this._requests[kind]) this._setSections({ ...this._sections, [kind]: { ...this._sections[kind], state: this._sections[kind].items.length && !more ? "ready" : "error" } });
      return false;
    }
  }

  /** Asks for what the lists do not carry: the days, the surest ID, the description. They are extras: when asking fails the sheet is simply without them, and the lists carry on. */
  private async _loadFacts(): Promise<void> {
    const hass = this.hass;
    const name = this.species?.species;
    if (!hass || !name) return;
    const request = ++this._factsRequest;
    try {
      const facts = speciesFacts(await api.speciesDetail(hass, name));
      if (request !== this._factsRequest || name !== this.species?.species) return;
      FACTS.delete(name);
      FACTS.set(name, { at: Date.now(), facts });
      while (FACTS.size > CACHE_MAX) FACTS.delete(FACTS.keys().next().value as string);
      this._facts = facts;
    } catch {
      // nothing to show for them
    }
  }

  private _onClose(event: CustomEvent<LuCloseDetail>): void {
    event.stopPropagation();
    this.dispatchEvent(new CustomEvent("close", { detail: event.detail }));
  }

  private _open(event: Event, kind: VisitKind): void {
    const id = (event as CustomEvent<{ id: string }>).detail.id;
    const visit = this._sections[kind].items.find((item) => item.id === id);
    this.dispatchEvent(new CustomEvent("open-visit", { detail: { id, visit } }));
  }

  private _warm(event: Event): void {
    this.dispatchEvent(new CustomEvent("warm-visit", { detail: { id: (event as CustomEvent<{ id: string }>).detail.id } }));
  }

  private _cameraName(id: string): string {
    return this.cameras.find((camera) => String(camera.id) === id)?.name ?? `Camera ${id}`;
  }

  private _total(kind: VisitKind, species: Species): number {
    const known = kind === "seen" ? species.seenCount30d : species.heardCount30d;
    return typeof known === "number" ? known : this._sections[kind].items.length;
  }

  private _renderSection(kind: VisitKind, species: Species) {
    const section = this._sections[kind];
    const total = this._total(kind, species);
    const [one, many] = NOUN[kind];
    const summary = total > 0 ? `${total} ${total === 1 ? one : many}` : "";
    const loadingMore = section.state === "loading" && section.items.length > 0;
    return html`<kestrel-lu-section .icon=${KIND[kind].icon} .heading=${TITLE[kind]} .summary=${summary} .state=${section.state} .count=${section.items.length} .empty=${EMPTY[kind]} .noun=${many} .variant=${kind === "seen" ? "thumbs" : "rows"} @lu-retry=${() => this._load(kind, section.items.length > 0)}>
      ${kind === "seen"
        ? html`<kestrel-lu-media-rail .items=${this._rail} .more=${section.next !== null} .loading=${loadingMore} @lu-select=${(event: Event) => this._open(event, "seen")} @lu-warm=${this._warm} @lu-more=${() => this._load("seen", true)}></kestrel-lu-media-rail>`
        : html`<kestrel-recording-list .hass=${this.hass} .rows=${this._rows} .more=${section.next !== null} .loading=${loadingMore} @lu-select=${(event: Event) => this._open(event, "heard")} @lu-more=${() => this._load("heard", true)}></kestrel-recording-list>`}
    </kestrel-lu-section>`;
  }

  private _renderHours(species: Species) {
    const hours = species.hours ?? [];
    const bars = Array.from({ length: 24 }, (_, hour) => ({ value: Number(hours[hour]) || 0, title: `${hour}:00 — ${hours[hour] ?? 0} visits` }));
    return html`<section class="block"><h3>When it visits</h3>${barChart(bars, ["12 am", "6 am", "12 pm", "6 pm", "12 am"], "Visits by hour of day")}</section>`;
  }

  /** The last 30 days, a bar for each: how busy the species has been lately, next to the 24-hour chart of when in the day. */
  private _renderDays() {
    const facts = this._facts;
    if (!facts?.perDay.length) return nothing;
    const days = dayBars(facts);
    const last = days.bars.length - 1;
    const labels = [days.bars[0].label, days.bars[Math.floor(last / 2)].label, days.bars[last].label];
    const bars = days.bars.map((bar) => ({ value: bar.count, title: `${bar.label} — ${pluralize(bar.count, "visit")}` }));
    return html`<section class="block"><h3>Last ${days.bars.length} days</h3>${days.total > 0
      ? html`${barChart(bars, labels, dayChartLabel(days))}<p class="caption days">${dayCaption(days)}</p>`
      : html`<p class="line muted">No visits in the last ${days.bars.length} days.</p>`}</section>`;
  }

  /** A few sentences from Wikipedia, with who wrote them and under which licence. */
  private _renderAbout() {
    const facts = this._facts;
    if (!facts?.description) return nothing;
    return html`<section class="block"><h3>About</h3><p class="blurb">${facts.description}</p>${descriptionCredit(facts.credit ?? DEFAULT_CREDIT)}</section>`;
  }

  /** First and last time, and the surest ID: small cells under the photo. The surest ID is the one that opens something (that visit). */
  private _renderFacts(species: Species) {
    const rows = factRows(species, this._facts);
    return rows.length ? html`<div class="facts">${rows.map((row) => this._renderFact(row))}</div>` : nothing;
  }

  private _renderFact(row: FactRow) {
    const body = html`<span class="fact-label">${renderIcon(row.icon)}${row.label}</span><strong>${row.value}</strong>`;
    const id = row.visitId;
    return id
      ? html`<button class="fact fact-link" type="button" aria-label=${`${row.label}: ${row.value}. Open that visit`} @click=${() => this.dispatchEvent(new CustomEvent("open-visit", { detail: { id } }))}>${body}${renderIcon("mdi:chevron-right", "icon fact-go")}</button>`
      : html`<div class="fact">${body}</div>`;
  }

  private _renderCameras(species: Species) {
    const cameras = Object.entries(species.cameras ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 8);
    return html`<section class="block"><h3>Cameras</h3>${cameras.length
      ? html`<ul class="simple" role="list">${cameras.map(([id, count]) => html`<li><span>${this._cameraName(id)}</span><strong>${count}</strong></li>`)}</ul>`
      : html`<p class="line muted">No camera breakdown is available yet.</p>`}</section>`;
  }

  static styles = [BASE_CSS, HEARD_HERO_CSS, BARS_CSS, css`
    .credit { margin-top: var(--lu-space-1); overflow-wrap: anywhere; }
    :host { display: contents; }
    h3, p { margin: 0; }
    h3 { margin-bottom: var(--lu-space-3); font-size: var(--lu-type-label); font-weight: 600; }
    ul { margin: 0; padding: 0; list-style: none; }
    .hero { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(110px, .6fr); align-items: center; gap: var(--lu-space-4); margin-bottom: var(--lu-space-2); }
    .photo { position: relative; }
    .badges { position: absolute; inset: var(--lu-space-2) var(--lu-space-2) auto; z-index: 1; display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--lu-space-1) var(--lu-space-2); pointer-events: none; }
    .badges .new { margin-inline-end: auto; }
    .total { display: grid; gap: var(--lu-space-1); text-align: center; }
    .total strong { font-size: var(--lu-type-display); font-weight: 350; font-variant-numeric: tabular-nums; line-height: 1; }
    .total span { color: var(--lu-ink-2); font-size: var(--lu-type-caption); }
    .facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(104px, 1fr)); gap: var(--lu-space-2); margin-bottom: var(--lu-space-2); }
    .fact { position: relative; display: grid; align-content: center; gap: 2px; min-width: 0; min-height: var(--lu-target); padding: var(--lu-space-2) var(--lu-space-3); border: 1px solid var(--lu-edge); border-radius: var(--lu-radius-tile); color: var(--lu-ink); background: var(--lu-tile); font: inherit; text-align: start; }
    .fact strong { overflow-wrap: anywhere; font-size: var(--lu-type-label); font-weight: 600; font-variant-numeric: tabular-nums; }
    .fact-label { display: flex; align-items: center; gap: var(--lu-space-1); color: var(--lu-ink-3); font-size: var(--lu-type-caption); }
    .fact-label .icon { --lu-icon: 14px; flex: none; }
    .fact-link { cursor: pointer; -webkit-tap-highlight-color: transparent; }
    .fact-link:is(:active, [data-pressed]) { background: var(--lu-material-press-wash); }
    .fact-go { --lu-icon: 16px; position: absolute; top: var(--lu-space-2); inset-inline-end: var(--lu-space-2); color: var(--lu-ink-3); }
    .blurb { color: var(--lu-ink-2); font-size: var(--lu-type-label); line-height: 1.5; }
    .days { margin-top: var(--lu-space-1); }
    .block { margin-top: var(--lu-space-5); padding-top: var(--lu-space-4); border-top: 1px solid var(--lu-edge); }
    .line { display: flex; flex-wrap: wrap; align-items: center; gap: var(--lu-space-2); min-height: var(--lu-target); font-size: var(--lu-type-label); }
    .simple li { display: flex; min-height: var(--lu-target); align-items: center; justify-content: space-between; gap: var(--lu-space-3); border-bottom: 1px solid var(--lu-edge); color: var(--lu-ink-2); font-size: var(--lu-type-label); }
    .simple li:last-child { border-bottom: 0; }
    .simple strong { color: var(--lu-ink); font-variant-numeric: tabular-nums; }
    .footer { display: flex; flex-wrap: wrap; align-items: center; gap: var(--lu-space-3); }
    .caption { color: var(--lu-ink-3); font-size: var(--lu-type-caption); }
    @container (max-width: 400px) {
      .hero { grid-template-columns: 1fr; }
      .total { justify-items: start; text-align: left; }
    }
    @media (max-height: 500px) {
      .hero { grid-template-columns: auto 1fr; justify-items: start; gap: var(--lu-space-5); }
      .photo { width: calc(var(--lu-target) * 3.5); }
      .total { justify-items: start; text-align: left; }
    }
  `];

  render() {
    const species = this.species;
    if (!species) return nothing;
    const picture = speciesPicture(species);
    const showChip = picture.isReference && !this._photoFailed;
    const group = GROUP_LABEL[species.grp] ?? GROUP_LABEL.unknown;
    const scientific = this._facts?.scientific ?? species.scientific;
    const subheading = scientific ? `${group} · ${scientific}` : group;
    const badge = newChip(species, this._facts);
    const badges = badge || showChip
      ? html`<div class="badges">${badge ? html`<kestrel-lu-chip class="new" kind="info" overlay icon=${badge.icon} label=${badge.label}></kestrel-lu-chip>` : nothing}${showChip ? html`<kestrel-lu-chip overlay label="Reference photo"></kestrel-lu-chip>` : nothing}</div>`
      : nothing;
    return html`<kestrel-lu-sheet .open=${this.open} .history=${false} engine="native" layer="species" .heading=${species.species} .subheading=${subheading} @lu-close=${this._onClose}>
      <div class="hero">
        <div class="photo">
          <kestrel-lu-image .src=${picture.url ?? ""} ratio="16/10" alt=${species.species} @lu-image-error=${() => { this._photoFailed = true; }}>${species.heard ? heardHero(KIND.heard.icon, "fallback") : nothing}</kestrel-lu-image>
          ${species.heard && !picture.url ? heardHero(KIND.heard.icon) : nothing}
          ${badges}
          ${showChip ? photoCaption(this._credit) : nothing}
        </div>
        <div class="total"><strong>${species.count30d}</strong><span>${species.count30d === 1 ? "visit" : "visits"} in the last 30 days</span></div>
      </div>
      ${this._renderFacts(species)}
      <kestrel-reference-sound .hass=${this.hass} .species=${species.species}></kestrel-reference-sound>
      ${this._renderSection("seen", species)}
      ${this._renderSection("heard", species)}
      ${this._renderHours(species)}
      ${this._renderDays()}
      ${this._renderAbout()}
      ${this._renderCameras(species)}
      <div slot="footer" class="footer"><kestrel-lu-button kind="secondary" icon=${this.muted ? "mdi:bell-outline" : "mdi:bell-off-outline"} ?disabled=${!this.canMute} label=${this.muted ? "Unmute notifications" : "Mute notifications"} @click=${() => this.dispatchEvent(new CustomEvent("toggle-mute"))}></kestrel-lu-button><span class="caption">${this.muted ? "Muted for wildlife alerts" : "Wildlife alerts are enabled"}</span></div>
    </kestrel-lu-sheet>`;
  }
}

customElements.define("kestrel-species-sheet", KestrelSpeciesSheet);

declare global { interface HTMLElementTagNameMap { "kestrel-species-sheet": KestrelSpeciesSheet; } }
