import { clamp, dateTime, pluralize, sentence, timestamp, when } from "./format.ts";
import type { Species } from "./types.ts";

/** Who wrote a species' description and under which licence. The links are https addresses, or null. */
export interface DescriptionCredit { name: string; url: string | null; licence: string; licenceUrl: string | null }

/** What the plugin and Home Assistant add to a species sheet's answer (`kestrel/species/detail`). Anything missing or odd is empty, never an error. */
export interface SpeciesFacts {
  /** Visits per day, oldest first, the last one is today. */
  perDay: number[];
  /** The date (YYYY-MM-DD) of `perDay[0]`; null when the answer did not say. */
  perDayFrom: string | null;
  firstAt: number | null;
  lastAt: number | null;
  /** How sure the surest ID was (0 to 1) and which visit it was. */
  bestScore: number | null;
  bestVisitId: string | null;
  newThisSeason: boolean;
  newToHome: boolean;
  scientific: string | null;
  description: string | null;
  credit: DescriptionCredit | null;
}

/** Shown under a description whose answer did not name its source: a Wikipedia summary, which is what Home Assistant asks for. */
export const DEFAULT_CREDIT: DescriptionCredit = { name: "Wikipedia", url: null, licence: "CC BY-SA 4.0", licenceUrl: null };

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 366;
const MAX_BLURB = 700;

const text = (value: unknown): string => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");
const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});

function https(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function moment(value: unknown): number | null {
  return typeof value === "number" || typeof value === "string" ? timestamp(value) : null;
}

/** A few sentences, cut after the last full sentence that fits (or at a word, with "…") if an answer is ever longer than a sheet should carry. */
export function trimBlurb(value: string, max = MAX_BLURB): string {
  if (value.length <= max) return value;
  const head = value.slice(0, max);
  const stop = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "));
  if (stop > max / 2) return head.slice(0, stop + 1);
  return `${head.slice(0, Math.max(head.lastIndexOf(" "), 1)).replace(/[\s,;:.-]+$/, "")}…`;
}

/** Reads `kestrel/species/detail` for what the sheet adds to the species list's own fields. The fields are on the top level of the answer; an answer that
 * nests the species in `species` is read too. */
export function speciesFacts(raw: unknown): SpeciesFacts {
  const top = record(raw);
  const inner = record(top.species);
  const get = (key: string): unknown => top[key] ?? inner[key];
  const days = get("perDay");
  const from = get("perDayFrom");
  const score = get("bestScore");
  const best = get("bestVisitId");
  const description = trimBlurb(text(get("description")));
  const source = record(get("descriptionSource"));
  return {
    perDay: Array.isArray(days) && days.length <= MAX_DAYS ? days.map((count) => (typeof count === "number" && Number.isFinite(count) && count > 0 ? Math.round(count) : 0)) : [],
    perDayFrom: typeof from === "string" && ISO_DAY.test(from) ? from : null,
    firstAt: moment(get("firstAt")),
    lastAt: moment(get("lastAt")),
    bestScore: typeof score === "number" && Number.isFinite(score) ? clamp(score, 0, 1) : null,
    bestVisitId: (typeof best === "string" && best.trim()) || (typeof best === "number" && Number.isFinite(best) && String(best)) || null,
    newThisSeason: get("newThisSeason") === true,
    newToHome: get("newToHome") === true,
    scientific: text(get("scientific")).slice(0, 80) || null,
    description: description || null,
    credit: description && Object.keys(source).length ? { name: text(source.name) || DEFAULT_CREDIT.name, url: https(source.url), licence: text(source.licence), licenceUrl: https(source.licenceUrl) } : null,
  };
}

/** YYYY-MM-DD of a moment in this device's own calendar. */
export function isoDay(ms: number): string {
  const day = new Date(ms);
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
}

/** The date `days` days after `iso` (before, when negative). Pure calendar arithmetic: a day with a clock change in it still counts as one. */
export function addDays(iso: string, days: number): string {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

let labelFormat: Intl.DateTimeFormat | undefined;
/** "Nov 14". */
export function dayLabel(iso: string): string {
  labelFormat ??= new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  return labelFormat.format(Date.parse(`${iso}T00:00:00Z`));
}

export interface DayBar { date: string; count: number; label: string }
export interface DayBars { bars: DayBar[]; total: number; busiest: DayBar | null }

/** One bar per day for the chart. The last day is called "Today"; the others by their date. The busiest day (the latest one when several tie) is
 * what the caption names. Without `perDayFrom` the days are counted back from this device's today. */
export function dayBars(facts: Pick<SpeciesFacts, "perDay" | "perDayFrom">, now = Date.now()): DayBars {
  const days = facts.perDay;
  const from = facts.perDayFrom ?? addDays(isoDay(now), 1 - days.length);
  const bars = days.map((count, index): DayBar => {
    const date = addDays(from, index);
    return { date, count, label: index === days.length - 1 ? "Today" : dayLabel(date) };
  });
  let busiest: DayBar | null = null;
  for (const bar of bars) if (bar.count > 0 && (!busiest || bar.count >= busiest.count)) busiest = bar;
  return { bars, total: bars.reduce((sum, bar) => sum + bar.count, 0), busiest };
}

/** "12 visits in the last 30 days · busiest Nov 3 (4)". */
export function dayCaption(days: DayBars): string {
  const lead = `${pluralize(days.total, "visit")} in the last ${days.bars.length} days`;
  const busiest = days.busiest;
  return busiest ? `${lead} · busiest ${busiest.label === "Today" ? "today" : busiest.label} (${busiest.count})` : lead;
}

/** What a screen reader hears for the daily chart (the bars themselves are not read one by one). */
export function dayChartLabel(days: DayBars): string {
  return `Visits per day, last ${days.bars.length} days. ${dayCaption(days)}.`;
}

export interface FactRow {
  key: "first" | "last" | "best";
  icon: string;
  label: string;
  value: string;
  /** The visit the row opens (the surest ID's visit); null for a row that only tells. */
  visitId: string | null;
}

/** "First heard · Nov 3, 2026, 6:12 AM", "Last heard · 5 min ago", "Surest ID · 91% sure". A species seen and heard says "detected". Shown from the list's own
 * first and last times until the sheet's answer is in. */
export function factRows(species: Pick<Species, "seen" | "heard" | "first" | "last">, facts: SpeciesFacts | null, now = Date.now()): FactRow[] {
  const verb = species.heard && !species.seen ? "heard" : species.seen && !species.heard ? "seen" : "detected";
  const first = facts?.firstAt ?? timestamp(species.first);
  const last = facts?.lastAt ?? timestamp(species.last);
  const rows: FactRow[] = [];
  if (first !== null) rows.push({ key: "first", icon: "mdi:calendar-start", label: `First ${verb}`, value: dateTime(first), visitId: null });
  if (last !== null) rows.push({ key: "last", icon: "mdi:clock-outline", label: `Last ${verb}`, value: sentence(when(last, now)), visitId: null });
  if (facts?.bestScore != null && facts.bestScore > 0) {
    rows.push({ key: "best", icon: "mdi:bullseye-arrow", label: "Surest ID", value: `${Math.round(facts.bestScore * 100)}% sure`, visitId: facts.bestVisitId });
  }
  return rows;
}

/** The one "new" chip a species gets, the most specific that is true: new to the home, else new this season, else new this year (the species list's own flag). */
export function newChip(species: Pick<Species, "newThisYear">, facts: Pick<SpeciesFacts, "newThisSeason" | "newToHome"> | null): { label: string; icon: string } | null {
  if (facts?.newToHome) return { label: "New to your home", icon: "mdi:home-plus-outline" };
  if (facts?.newThisSeason) return { label: "New this season", icon: "mdi:star-outline" };
  if (species.newThisYear) return { label: "New this year", icon: "mdi:star-outline" };
  return null;
}
