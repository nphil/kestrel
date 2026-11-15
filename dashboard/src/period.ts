/** The stretches of time the Wildlife list and the Home Assistant cards can look at. The server counts them in the home's own time zone
 * ("today" starts at midnight there), so the browser never works out a day itself. */
export type SpeciesPeriod = "today" | "week" | "month" | "all";

export const PERIODS: readonly SpeciesPeriod[] = ["today", "week", "month", "all"];

/** "All time" keeps Wildlife what it has always been: every species ever seen or heard. */
export const DEFAULT_PERIOD: SpeciesPeriod = "all";

/** The words on the switch. */
export const PERIOD_LABEL: Record<SpeciesPeriod, string> = { today: "Today", week: "7 days", month: "30 days", all: "All time" };

/** The same period in the middle of a sentence: "Nothing on camera in the last 7 days". */
export const PERIOD_PHRASE: Record<SpeciesPeriod, string> = { today: "today", week: "in the last 7 days", month: "in the last 30 days", all: "yet" };

/** A period from whatever was stored or typed in a card's settings; anything that is not one of the four is `fallback`. */
export function asPeriod(value: unknown, fallback: SpeciesPeriod = DEFAULT_PERIOD): SpeciesPeriod {
  return typeof value === "string" && (PERIODS as readonly string[]).includes(value) ? value as SpeciesPeriod : fallback;
}

/** The name a Wildlife list is kept under in the browser's memory, so the panel and the cards that show the same list share one answer and one request. Change it when the shape of the answer changes. */
export const speciesKey = (period: SpeciesPeriod): string => (period === "all" ? "kestrel/species/v1" : `kestrel/species/v1:${period}`);
