import { pluralize, sentence, timestamp, when } from "./format.ts";
import { PERIOD_LABEL, asPeriod, type SpeciesPeriod } from "./period.ts";
import type { Group, Species, VisitKind } from "./types.ts";
import { stableUrl } from "./urls.ts";
import { KIND, asKind, evidenceCount } from "./vocab.ts";
import { emptyWildlife, inPeriod, lastActivity, matchesFilter, tileCount, type SpeciesFilter } from "./wildlife.ts";

/* Everything the two Home Assistant cards decide that is not drawing: what their settings mean, what a highlight says, which species make the list. */

/** Which visits a card counts: everything, only what cameras caught, or only what microphones heard. */
export type KindChoice = "both" | "seen" | "heard";
export const KIND_CHOICES: readonly KindChoice[] = ["both", "seen", "heard"];

/** The same choice in the Wildlife list's words. */
export const filterOf = (kinds: KindChoice): SpeciesFilter => (kinds === "both" ? "all" : kinds);

function choice(value: unknown): KindChoice {
  return typeof value === "string" && (KIND_CHOICES as readonly string[]).includes(value) ? value as KindChoice : "both";
}

const flag = (value: unknown, fallback: boolean): boolean => (typeof value === "boolean" ? value : fallback);
const settings = (raw: unknown): Record<string, unknown> => (raw && typeof raw === "object" ? raw as Record<string, unknown> : {});

/* ---- where a tap goes ---- */

/** The panel's address in Home Assistant. A card sits on a dashboard, so the page it is on says nothing about where the panel is. */
export const PANEL_PATH = "/kestrel";
export const speciesRoute = (species: string): string => `${PANEL_PATH}/wildlife?s=${encodeURIComponent(species)}`;
export const visitRoute = (id: string): string => `${PANEL_PATH}/visit?v=${encodeURIComponent(id)}`;

/* ---- the highlight card ---- */

/** What a highlight card shows: the newest visit, the species with the most visits, or the one with the fewest. */
export type HighlightShow = "latest" | "most" | "least";
export const HIGHLIGHT_SHOWS: readonly HighlightShow[] = ["latest", "most", "least"];

export interface HighlightConfig {
  show: HighlightShow;
  period: SpeciesPeriod;
  kinds: KindChoice;
  showName: boolean;
  showScientific: boolean;
  showTime: boolean;
  showCount: boolean;
}

/** The settings as they are written in a dashboard's YAML. Every one is optional: `highlightConfig` gives the missing ones their defaults. */
export interface HighlightCardConfig {
  type: string;
  show?: HighlightShow;
  period?: SpeciesPeriod;
  kinds?: KindChoice;
  show_name?: boolean;
  show_scientific_name?: boolean;
  show_time?: boolean;
  show_count?: boolean;
}

/** The card's settings from whatever the dashboard's YAML holds: a setting that is missing, or not one of its choices, is its default. */
export function highlightConfig(raw: unknown): HighlightConfig {
  const source = settings(raw);
  return {
    show: typeof source.show === "string" && (HIGHLIGHT_SHOWS as readonly string[]).includes(source.show) ? source.show as HighlightShow : "latest",
    period: asPeriod(source.period, "week"),
    kinds: choice(source.kinds),
    showName: flag(source.show_name, true),
    showScientific: flag(source.show_scientific_name, false),
    showTime: flag(source.show_time, true),
    showCount: flag(source.show_count, true),
  };
}

/** The settings as the editor shows and writes them: every one, with what the card does when it is not written down. */
export function highlightYaml(config: HighlightConfig): Omit<HighlightCardConfig, "type"> {
  return { show: config.show, period: config.period, kinds: config.kinds, show_name: config.showName, show_scientific_name: config.showScientific, show_time: config.showTime, show_count: config.showCount };
}

/** One highlighted species. `count` is its visits in the period (of the kinds asked for), `total` its visits ever; `visitId` the newest of them, which a tap on "latest" opens. */
export interface Highlight {
  species: string;
  scientific: string | null;
  grp: Group;
  kind: VisitKind;
  count: number;
  total: number;
  at: number | null;
  visitId: string | null;
  photo_url: string | null;
  referenceImage: string | null;
}

/** The three highlights of one question (a period, a choice of kinds); a part nobody qualifies for is null. */
export interface Highlights { latest: Highlight | null; top: Highlight | null; rare: Highlight | null }

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const whole = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0);
const GROUPS: readonly string[] = ["bird", "mammal", "other", "unknown"];

/** One highlight from the server's answer; null when it names no species or no kind of visit. Picture links are made steady (see `stableUrl`). */
export function readHighlight(value: unknown): Highlight | null {
  const raw = settings(value);
  const species = text(raw.species);
  const kind = asKind(raw.kind);
  if (!species || !kind) return null;
  const count = whole(raw.count);
  const id = typeof raw.visitId === "number" ? String(raw.visitId) : text(raw.visitId);
  return {
    species,
    scientific: text(raw.scientific) || null,
    grp: GROUPS.includes(text(raw.grp)) ? text(raw.grp) as Group : "unknown",
    kind,
    count,
    total: Math.max(count, whole(raw.total)),
    at: timestamp(typeof raw.at === "number" || typeof raw.at === "string" ? raw.at : null),
    visitId: id || null,
    photo_url: stableUrl(text(raw.photo_url)) || null,
    referenceImage: stableUrl(text(raw.referenceImage)) || null,
  };
}

export function readHighlights(value: unknown): Highlights {
  const raw = settings(value);
  return { latest: readHighlight(raw.latest), top: readHighlight(raw.top), rare: readHighlight(raw.rare) };
}

export function highlightFor(highlights: Highlights, show: HighlightShow): Highlight | null {
  return show === "latest" ? highlights.latest : show === "most" ? highlights.top : highlights.rare;
}

/** The question a highlight card asks the server, which is also the key its answer is kept under (cards that ask the same share one answer). */
export const highlightsKey = (period: SpeciesPeriod, kinds: KindChoice): string => `kestrel/highlights/v1:${period}:${kinds}`;

/** What the card says above the name for a choice of what to show, over what kinds: "Latest", "Most heard", "Least frequent". */
export function headline(show: HighlightShow, kinds: KindChoice): string {
  if (show === "latest") return kinds === "both" ? "Latest" : `Latest ${kinds}`;
  const how = kinds === "both" ? "frequent" : kinds;
  return `${show === "most" ? "Most" : "Least"} ${how}`;
}

/** What the card says above the name: "Latest · Today", "Most heard · 7 days". */
export function eyebrow(show: HighlightShow, period: SpeciesPeriod, kinds: KindChoice): string {
  return `${headline(show, kinds)} · ${PERIOD_LABEL[period]}`;
}

/** "12 visits", or "12 videos" / "12 recordings" when the card counts only one kind. */
export function visitsText(count: number, kinds: KindChoice): string | null {
  if (count <= 0) return null;
  return kinds === "both" ? pluralize(count, "visit") : evidenceCount(kinds, count);
}

/** The words of one highlight card. `time` and `count` are null when there is nothing to say or the card is set not to say it; `label` is the whole card for a screen reader, whatever the settings hide. */
export interface HighlightText { eyebrow: string; name: string | null; scientific: string | null; time: string | null; count: string | null; label: string }

export function highlightText(item: Highlight, config: HighlightConfig, now = Date.now()): HighlightText {
  const head = eyebrow(config.show, config.period, config.kinds);
  const time = item.at === null ? null : `${KIND[item.kind].verb} ${when(item.at, now)}`;
  const count = visitsText(item.count, config.kinds);
  return {
    eyebrow: head,
    name: config.showName ? item.species : null,
    scientific: config.showScientific ? item.scientific : null,
    time: config.showTime ? time : null,
    count: config.showCount ? count : null,
    label: [head, item.species, time, count].filter(Boolean).join(". "),
  };
}

/** Where a tap on the card goes: the newest visit for "latest" (when the server said which), otherwise the species. */
export function highlightRoute(item: Highlight, show: HighlightShow): string {
  return show === "latest" && item.visitId ? visitRoute(item.visitId) : speciesRoute(item.species);
}

/** What the card says when there is nothing to highlight, the same words the Wildlife list uses for the same question. */
export function highlightEmpty(config: Pick<HighlightConfig, "period" | "kinds">): string {
  return emptyWildlife(config.period, filterOf(config.kinds)).heading;
}

/* ---- the species list card ---- */

export interface ListConfig { period: SpeciesPeriod; limit: number; kinds: KindChoice }

/** The settings as they are written in a dashboard's YAML. Every one is optional: `listConfig` gives the missing ones their defaults. */
export interface ListCardConfig { type: string; period?: SpeciesPeriod; limit?: number; kinds?: KindChoice }

export const LIST_LIMIT = { min: 1, max: 24, fallback: 6 } as const;

/** The card's settings from whatever the dashboard's YAML holds; `limit` is a whole number of rows, kept within what a card can sensibly show. */
export function listConfig(raw: unknown): ListConfig {
  const source = settings(raw);
  const asked = typeof source.limit === "string" ? Number(source.limit) : source.limit;
  const limit = typeof asked === "number" && Number.isFinite(asked) ? Math.min(LIST_LIMIT.max, Math.max(LIST_LIMIT.min, Math.round(asked))) : LIST_LIMIT.fallback;
  return { period: asPeriod(source.period, "week"), limit, kinds: choice(source.kinds) };
}

/** The settings as the editor shows and writes them: every one, with what the card does when it is not written down. */
export function listYaml(config: ListConfig): Omit<ListCardConfig, "type"> {
  return { period: config.period, limit: config.limit, kinds: config.kinds };
}

const KINDS_OF: Record<KindChoice, readonly VisitKind[]> = { both: ["seen", "heard"], seen: ["seen"], heard: ["heard"] };

/** The visits of a species in the period, counting only the kinds the card is about. */
export function listVolume(species: Species, kinds: KindChoice): number {
  return KINDS_OF[kinds].reduce((total, kind) => total + (tileCount(species, kind) ?? 0), 0);
}

/** The species the list shows: those with a visit in the period (of the kinds asked for), the busiest first and the newest first among equals, cut to `limit`. */
export function listRows(species: readonly Species[], config: ListConfig): Species[] {
  const filter = filterOf(config.kinds);
  const inside = inPeriod([...species], config.period).filter((each) => matchesFilter(each, filter, config.period));
  const ranked = inside.map((each, index) => ({ each, index, volume: listVolume(each, config.kinds) }));
  ranked.sort((a, b) => b.volume - a.volume || a.index - b.index);
  return ranked.slice(0, config.limit).map(({ each }) => each);
}

/** The counts shown at the end of a row: one per kind the card is about and the species has in the period. */
export function listEvidence(species: Species, config: ListConfig): Array<{ kind: VisitKind; count: number }> {
  return KINDS_OF[config.kinds]
    .filter((kind) => matchesFilter(species, kind, config.period))
    .map((kind) => ({ kind, count: tileCount(species, kind) ?? 0 }))
    .filter(({ count }) => count > 0);
}

/** "Heard 3 min ago": when the species last turned up, in the kinds the card is about. */
export function listLast(species: Species, kinds: KindChoice, now = Date.now()): string | null {
  const own = kinds === "seen" ? timestamp(species.lastSeenAt) : kinds === "heard" ? timestamp(species.lastHeardAt) : null;
  if (kinds !== "both") return own === null ? null : `${KIND[kinds].verb} ${when(own, now)}`;
  const activity = lastActivity(species);
  if (!activity) return null;
  return activity.kind ? `${KIND[activity.kind].verb} ${when(activity.at, now)}` : sentence(when(activity.at, now));
}

/** The card's heading: "Wildlife · 7 days". */
export const listTitle = (period: SpeciesPeriod): string => `Wildlife · ${PERIOD_LABEL[period]}`;
