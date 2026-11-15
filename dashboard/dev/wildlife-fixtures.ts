/* What the harness answers for the wildlife features: the species list for a period, one species' facts, the highlights, and the weather and
 * spectrogram of recordings. Everything is worked out from the fixture visits, so a number on a tile agrees with the visits the sheet pages through.
 * Only the days before yesterday are made up (the fixture visits are all from the last two days): see STORIES. Pure; dev/harness.ts hands it the visits. */
import { addDays, isoDay } from "../src/facts.ts";
import { asPeriod, type SpeciesPeriod } from "../src/period.ts";
import type { Species, Visit, VisitKind } from "../src/types.ts";

const DAY = 86_400_000;
const DAYS = 30;

export interface WildlifeFixtures {
  visits: readonly Visit[];
  /** The species with a made-up history (the fixtures' own; a bench species has only the visits it really has). */
  storied: ReadonlySet<string>;
  scientific: (name: string) => string | null;
  /** Harness setting `quiet=1`: a day nothing has come yet, so "Today" is empty. */
  quiet: boolean;
}

/** How a species' last 30 days went before yesterday: it began `from` days ago (29 = the whole month), came about `rate` times on a day it came,
 * and its very first visit was `ever` days ago. `season` marks one that is new this season. */
interface Story { from: number; rate: number; ever: number; season?: boolean }
const STORIES: Record<string, Story> = {
  "Northern Cardinal": { from: 29, rate: 2.6, ever: 400 },
  "Eastern Gray Squirrel": { from: 29, rate: 1.4, ever: 300 },
  "Blue Jay": { from: 26, rate: 1.1, ever: 210 },
  "Common Raccoon": { from: 29, rate: 0.5, ever: 500 },
  "Spring Peeper": { from: 18, rate: 0.7, ever: 90 },
  "Dark-eyed Junco": { from: 3, rate: 2, ever: 260, season: true },
  "Eastern Screech-Owl": { from: 0, rate: 0, ever: 0 },
  "Great Horned Owl": { from: 0, rate: 0, ever: 0 },
  "House Mouse": { from: 1, rate: 0, ever: 1 },
};

function hash(text: string): number {
  let value = 2166136261;
  for (const letter of text) value = Math.imul(value ^ letter.charCodeAt(0), 16777619) >>> 0;
  return value;
}
/** A number from 0 up to (not including) 1 that depends only on the two it is given. */
function unit(seed: number, n: number): number {
  let value = (seed ^ Math.imul(n + 1, 0x9e3779b1)) >>> 0;
  value = Math.imul(value ^ (value >>> 15), 0x85ebca6b) >>> 0;
  value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35) >>> 0;
  return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
}
function storyOf(name: string): Story {
  const known = STORIES[name];
  if (known) return known;
  const h = hash(name);
  return h % 3 === 0 ? { from: 1, rate: 0, ever: 1 } : { from: 6 + (h % 24), rate: 0.4 + (h % 7) / 5, ever: 40 + (h % 5) * 50 };
}

interface Seen { id: string; at: number; kind: VisitKind; score: number | null }
interface History { perDay: number[]; older: number; firstAt: number | null; mine: Seen[]; seenShare: number; story: Story | null }

const dayNumber = (ms: number): number => Date.parse(`${isoDay(ms)}T00:00:00Z`) / DAY;

function historyOf(name: string, fx: WildlifeFixtures, now: number): History {
  const mine = fx.visits
    .filter((item) => item.species === name && item.status !== "not_animal" && item.status !== "unknown")
    .map((item): Seen => ({ id: item.id, at: typeof item.startedAt === "number" ? item.startedAt : Date.parse(item.startedAt), kind: item.kind, score: item.score ?? null }))
    .sort((a, b) => b.at - a.at);
  const story = fx.storied.has(name) ? storyOf(name) : null;
  const perDay = Array<number>(DAYS).fill(0);
  let older = 0;
  for (const { at } of mine) {
    const ago = dayNumber(now) - dayNumber(at);
    if (ago < DAYS) perDay[DAYS - 1 - ago] += 1;
    else older += 1;
  }
  if (story) {
    const h = hash(name);
    for (let ago = 2; ago < DAYS; ago += 1) if (ago <= story.from && unit(h, ago) >= 0.3) perDay[DAYS - 1 - ago] += Math.round(story.rate * (0.4 + 1.8 * unit(h + 1, ago)));
    older += Math.round(Math.max(0, story.ever - (DAYS - 1)) * story.rate * 0.35);
  }
  if (fx.quiet) perDay[DAYS - 1] = 0;
  const seen = mine.filter((item) => item.kind === "seen").length;
  const first = mine.length ? mine[mine.length - 1].at : null;
  const firstAt = story && story.rate > 0 ? Math.min(now - story.ever * DAY, first ?? Infinity) : first;
  return { perDay, older, firstAt, mine, seenShare: mine.length ? seen / mine.length : 0, story };
}

const total = (list: readonly number[], from: number): number => list.slice(from).reduce((sum, n) => sum + n, 0);

/** The visits of a species in a period (the plugin counts New York days; the harness counts this browser's): today since midnight, a week today and the six days
 * before, a month today and the 29 before, and all of them. */
function countsOf(history: History, period: SpeciesPeriod): { count: number; seen: number; heard: number } {
  const count = period === "today" ? total(history.perDay, DAYS - 1) : period === "week" ? total(history.perDay, DAYS - 7) : period === "month" ? total(history.perDay, 0) : total(history.perDay, 0) + history.older;
  const seen = Math.round(count * history.seenShare);
  return { count, seen, heard: count - seen };
}

/** When a period began (ms); null for all time. */
export function periodStart(period: SpeciesPeriod, now: number, quiet: boolean): number | null {
  if (period === "all") return null;
  if (period === "today" && quiet) return now + 1;
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  midnight.setDate(midnight.getDate() - (period === "today" ? 0 : period === "week" ? 6 : 29));
  return midnight.getTime();
}

export function speciesAnswer(list: readonly Species[], period: unknown, fx: WildlifeFixtures, now = Date.now()): { items: Species[]; period: SpeciesPeriod; since: number | null } {
  const wanted = asPeriod(period, "all");
  const items = list
    .map((item): Species => {
      const { count, seen, heard } = countsOf(historyOf(item.species, fx, now), wanted);
      return { ...item, scientific: fx.scientific(item.species) ?? item.scientific ?? null, periodCount: count, periodSeen: seen, periodHeard: heard };
    })
    .filter((item) => wanted === "all" || (item.periodCount ?? 0) > 0);
  return { items, period: wanted, since: periodStart(wanted, now, fx.quiet) };
}

const SEASONS = ["winter", "winter", "spring", "spring", "spring", "summer", "summer", "summer", "autumn", "autumn", "autumn", "winter"];
const wikipedia = (page: string) => ({ name: "Wikipedia", url: `https://en.wikipedia.org/wiki/${page}`, licence: "CC BY-SA 4.0", licenceUrl: "https://creativecommons.org/licenses/by-sa/4.0/" });
/** What Home Assistant would have fetched from Wikipedia. Common Raccoon's answer carries no source (the sheet then credits Wikipedia itself); the rest have none at all. */
const ABOUT: Record<string, { text: string; source: ReturnType<typeof wikipedia> | null }> = {
  "Northern Cardinal": { text: "The northern cardinal is a medium-sized songbird of eastern North America. Males are bright red with a black mask and a crest; females are warm brown with touches of red. They stay in the same area all year and sing from high perches, often in pairs.", source: wikipedia("Northern_cardinal") },
  "Blue Jay": { text: "The blue jay is a loud, clever songbird of eastern and central North America, with a blue crest, back and tail and a pale grey chest. It has many calls, including a good imitation of a hawk, and it stores acorns for the winter.", source: wikipedia("Blue_jay") },
  "Eastern Gray Squirrel": { text: "The eastern gray squirrel is a tree squirrel of eastern North America. It spends the autumn burying nuts and seeds and finds many of them again in winter. Its bushy tail helps it balance and keep warm.", source: wikipedia("Eastern_gray_squirrel") },
  "Common Raccoon": { text: "The raccoon is a medium-sized mammal of North America with a black mask and a ringed tail. It is mostly active at night, climbs well and uses its front paws to feel for food.", source: null },
  "Spring Peeper": { text: "The spring peeper is a tiny tree frog of eastern North America. In early spring the males call from ponds and wet woods with a high, rising peep that, from a whole chorus, sounds like sleigh bells.", source: wikipedia("Spring_peeper") },
  "Great Horned Owl": { text: "The great horned owl is a large owl found across most of the Americas. It has tufts of feathers like horns, yellow eyes and a deep, steady hoot. It hunts at night and can take animals as big as a skunk.", source: wikipedia("Great_horned_owl") },
};

export function detailAnswer(item: Species, fx: WildlifeFixtures, now = Date.now()): Record<string, unknown> {
  const history = historyOf(item.species, fx, now);
  const best = history.mine.filter((seen) => seen.score !== null).sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || b.at - a.at)[0];
  const about = ABOUT[item.species];
  return {
    ...item,
    scientific: fx.scientific(item.species),
    perDay: history.perDay, perDayFrom: addDays(isoDay(now), 1 - DAYS),
    firstAt: history.firstAt, lastAt: history.mine[0]?.at ?? null,
    bestScore: best?.score ?? null, bestVisitId: best?.id ?? null,
    newThisSeason: history.story?.season === true, newToHome: history.firstAt !== null && now - history.firstAt <= 7 * DAY,
    season: SEASONS[new Date(now).getMonth()],
    description: about?.text ?? null, descriptionSource: about?.source ?? null,
  };
}

/** The period's latest, most frequent and least frequent species, the way the plugin picks them (store.ts `highlights`): each is shown by its newest visit in the period, ties go to the newest, and among the least frequent to the one with fewest visits ever. */
export function highlightsAnswer(list: readonly Species[], period: unknown, kind: unknown, fx: WildlifeFixtures, now = Date.now()): Record<string, unknown> {
  const wanted = asPeriod(period, "all");
  const choice = kind === "seen" || kind === "heard" ? kind : "both";
  const since = periodStart(wanted, now, fx.quiet);
  const entries = list.flatMap((item) => {
    const history = historyOf(item.species, fx, now);
    const inside = countsOf(history, wanted);
    const count = choice === "both" ? inside.count : inside[choice];
    const newest = history.mine.find((seen) => (choice === "both" || seen.kind === choice) && (since === null || seen.at >= since));
    if (count <= 0 || !newest) return [];
    const ever = countsOf(history, "all");
    return [{ item, newest, count, total: choice === "both" ? ever.count : ever[choice] }];
  }).sort((a, b) => b.newest.at - a.newest.at);
  const shape = (entry: (typeof entries)[number] | undefined) => entry ? {
    species: entry.item.species, scientific: fx.scientific(entry.item.species), grp: entry.item.grp, kind: entry.newest.kind, count: entry.count, total: entry.total, at: entry.newest.at, visitId: entry.newest.id,
    hasPhoto: entry.item.hasPhoto ?? false, photo_url: entry.item.photo_url ?? null, referenceImage: entry.item.referenceImage ?? null, referenceImageInfoUrl: entry.item.referenceImageInfoUrl ?? null,
  } : null;
  const top = [...entries].sort((a, b) => b.count - a.count)[0];
  const rare = [...entries].sort((a, b) => a.count - b.count || a.total - b.total)[0];
  return { period: wanted, kind: choice, latest: shape(entries[0]), top: shape(top), rare: shape(rare) };
}

const WEATHER = [
  { temp: 14, unit: "°C", conditions: "Clear sky", icon: "mdi:weather-sunny" },
  { temp: 9, unit: "°C", conditions: "Cloudy", icon: "mdi:weather-cloudy" },
  { temp: 11, unit: "°C", conditions: "Light rain", icon: "mdi:weather-rainy" },
  { temp: 4, unit: "°C", conditions: "Clear night", icon: "mdi:weather-night" },
  { temp: 7, unit: "°C", conditions: "Windy", icon: "mdi:weather-windy" },
];

/** `kestrel/recordings`: by the number a visit id ends in, every fifth has no weather, every sixth no spectrogram yet, and one in six a spectrogram BirdNET-Go cannot draw (the media route answers 204). */
export function recordingsAnswer(ids: unknown, media: (kind: string, id: string) => string): { items: Record<string, { weather: unknown; spectrogram: string | null }> } {
  const wanted = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string").slice(0, 20) : [];
  const entries = wanted.map((id) => {
    const n = Number(/(\d+)$/.exec(id)?.[1] ?? 0);
    return [id, { weather: n % 5 === 4 ? null : WEATHER[n % WEATHER.length], spectrogram: n % 6 === 2 ? null : media("birdnet_spectrogram", n % 6 === 5 ? `blank-${id}` : id) }] as const;
  });
  return { items: Object.fromEntries(entries) };
}
