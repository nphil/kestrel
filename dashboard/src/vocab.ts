import { pluralize } from "./format.ts";
import type { AudioAlternative, Group, PhotoCredit, ReferenceClip, Visit, VisitKind } from "./types.ts";

/** The panel's one icon vocabulary. Each kind of evidence has exactly one icon and one word, and every
 * tile, chip, row, sheet and page draws it from here, so a sound recording never looks like a video. */
export const KIND = {
  seen: { icon: "mdi:video", word: "Video", verb: "Seen" },
  heard: { icon: "mdi:waveform", word: "Heard", verb: "Heard" },
} as const satisfies Record<VisitKind, { icon: string; word: string; verb: string }>;

/** What a species sounds like, from a public sound library: the icon and word of the "Play reference" block. It is never the waveform
 * of a recording the microphones heard, so a library clip is never mistaken for one of those. */
export const REFERENCE = { icon: "mdi:book-music", word: "Reference" } as const;

export const GROUP_LABEL: Record<Group, string> = { bird: "Bird", mammal: "Mammal", other: "Wildlife", unknown: "Wildlife" };

export function asKind(value: unknown): VisitKind | null {
  return value === "seen" || value === "heard" ? value : null;
}

type TierFields = Partial<Pick<Visit, "status" | "tier" | "tierWhy" | "models" | "repeats" | "labelScore" | "score">>;

const TIER_WORD = { likely: "Likely", possible: "Possible", check: "Check this one" } as const;

/** "Likely", "Possible" or "Check this one" for a heard visit nobody has looked at yet; "" once a person confirmed or corrected it, or when no tier was recorded. */
export function tierWord(visit: TierFields): string {
  if (visit.status !== "auto" || !visit.tier || !Object.prototype.hasOwnProperty.call(TIER_WORD, visit.tier)) return "";
  return TIER_WORD[visit.tier];
}

/** A model's name in a sentence: "v3.0", "Perch", "BirdNET 2.4", or its own label. */
function modelName(call: { model?: string; label?: string } | undefined): string {
  if (!call) return "";
  const names: Record<string, string> = { birdnet_v3: "v3.0", perch_v2: "Perch", birdnet_v24: "BirdNET 2.4" };
  return (typeof call.model === "string" && names[call.model]) || (typeof call.label === "string" ? call.label.trim() : "");
}

/** One plain sentence (two at most) on why a heard visit got its tier, for the review list and the visit page. "" when there is nothing to say. */
export function tierWhyLine(visit: TierFields): string {
  if (visit.status !== undefined && visit.status !== "auto") return "";
  const why = Array.isArray(visit.tierWhy) ? [...new Set(visit.tierWhy)] : [];
  const calls = Array.isArray(visit.models) ? visit.models.filter((call) => call && typeof call === "object") : [];
  const named = calls.find((call) => call.role === "named");
  const other = calls.find((call) => call.role === "other");
  const once = !(typeof visit.repeats === "number" && visit.repeats >= 1) && !why.includes("repeated");
  const times = typeof visit.repeats === "number" && visit.repeats >= 1 ? Math.floor(visit.repeats) + 1 : 0;
  const sentences: string[] = [];
  for (const reason of why) {
    if (reason === "models_disagree") {
      const [first, second] = [modelName(named), modelName(other)];
      sentences.push(first && second && named?.species && other?.species ? `The two models disagree: ${first} says ${named.species}, ${second} says ${other.species}.` : "The two models disagree about this one.");
    } else if (reason === "second_opinion_only") {
      const heard = modelName(named);
      const missed = heard === "Perch" ? "v3.0" : heard === "v3.0" ? "Perch" : "";
      sentences.push(heard && missed ? `Only ${heard} heard this one; ${missed} did not.` : "Only one of the two models heard this one.");
    } else if (reason === "weak") {
      sentences.push(why.includes("new_here") ? "A faint call of a bird not heard here before." : `A faint call${once ? ", heard once" : ""}.`);
    } else if (reason === "new_here") {
      if (!why.includes("weak")) sentences.push("A bird not heard here before.");
    } else if (reason === "rare_here") {
      sentences.push(`An unusual bird for this time of year${once ? ", heard only once" : ""}.`);
    } else if (reason === "strong") {
      sentences.push("A clear call.");
    } else if (reason === "repeated" && times) {
      sentences.push(`Heard ${times} times within a few minutes.`);
    }
  }
  return sentences.slice(0, 2).join(" ");
}

/** The number shown as "NN% sure": the classifier's confidence in the label for a camera visit, else the visit's own score. Undefined when neither is a usable number. */
export function visitConfidence(visit: TierFields): number | undefined {
  const { labelScore, score } = visit;
  if (typeof labelScore === "number" && Number.isFinite(labelScore) && labelScore > 0 && labelScore <= 1) return labelScore;
  return typeof score === "number" && Number.isFinite(score) ? score : undefined;
}

/** "Heard" for a recording, "Video" for a sighting with a clip (or one still being saved), "Photo" for one without. */
export function evidenceWord(visit: Pick<Visit, "kind" | "clip">): string {
  if (visit.kind === "heard") return KIND.heard.word;
  const state = visit.clip?.state;
  return state === "none" || state === "deleted" ? "Photo" : KIND.seen.word;
}

/** "0:03–0:08": a stretch of a recording, in minutes and seconds. */
export function span(start: number, end: number): string {
  const clock = (seconds: number): string => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
  return `${clock(Math.max(0, start))}–${clock(Math.max(0, end))}`;
}

/** What to tell the listener about a recording that has been prepared: whether it was cleaned, and which
 * moment of the clip it is. Nothing while it is still being prepared, so the swap from the original is silent. */
export function recordingNotes(info: Pick<NonNullable<Visit["audioInfo"]>, "state" | "segment" | "cleaned"> | null | undefined): { mark: string; caption: string } {
  if (!info || info.state !== "ready") return { mark: "", caption: "" };
  return { mark: info.cleaned ? "Cleaned" : "", caption: info.segment ? `Matched moment · ${span(info.segment.start, info.segment.end)}` : "" };
}

/** "12 videos" or "35 recordings". */
export function evidenceCount(kind: VisitKind, count: number): string {
  return pluralize(count, kind === "seen" ? "video" : "recording");
}

/** "a Eurasian Wren", "an American Robin": the name with the right article, for a sentence like "What an American Robin sounds like". */
export function withArticle(name: string): string {
  return `${/^[aeiou]/i.test(name) && !/^(eu|uni|use)/i.test(name) ? "an" : "a"} ${name}`;
}

/** "12 s", "1 min 5 s": how long a clip is. No-break spaces keep a number on the same line as its unit. */
function clipLength(seconds: number): string {
  const whole = Math.max(1, Math.round(seconds));
  const minutes = Math.floor(whole / 60);
  return minutes ? `${minutes}\u00a0min${whole % 60 ? ` ${whole % 60}\u00a0s` : ""}` : `${whole}\u00a0s`;
}

/** The line under a reference recording, "Song · Jane Birder · CC BY-NC-SA 4.0 · Quality A · 14 s": the parts the clip has, with no stray separators. */
export function referenceCredit(clip: Pick<ReferenceClip, "label" | "credit" | "licence" | "quality" | "seconds">): string {
  return [clip.label, clip.credit, clip.licence, clip.quality ? `Quality\u00a0${clip.quality}` : "", clip.seconds ? clipLength(clip.seconds) : ""].filter(Boolean).join(" · ");
}

/** The caption under a reference photo, "Photo · Jane Birder · CC BY-NC · iNaturalist": the parts it has, with no stray separators. */
export function photoCredit(info: PhotoCredit): string {
  return ["Photo", info.credit, info.licence, info.source].filter(Boolean).join(" · ");
}

/** "31%": how strongly the second listen hears a species, as a whole percent. */
export function percentSure(score: number): string {
  return `${Math.round(Math.min(1, Math.max(0, score)) * 100)}%`;
}

/** The "Could also be" species of a heard visit: what the second listen (Perch) hears more strongly than the detector's call, best first, at most `limit`.
 * Nothing for a recording that has no such list, once a person has said the call is right or not an animal, or for a species the visit already is;
 * a score that cannot be one is left out. */
export function couldAlsoBe(visit: Pick<Visit, "kind" | "species" | "status" | "audioInfo">, limit = 3): AudioAlternative[] {
  const list = visit.audioInfo?.alternatives;
  if (visit.kind !== "heard" || visit.status === "confirmed" || visit.status === "not_animal" || !Array.isArray(list)) return [];
  const taken = new Set([typeof visit.species === "string" ? visit.species.trim().toLowerCase() : ""]);
  const found: AudioAlternative[] = [];
  for (const item of list) {
    const species = item && typeof item.species === "string" ? item.species.trim() : "";
    const score = item?.score;
    if (!species || typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1 || taken.has(species.toLowerCase())) continue;
    taken.add(species.toLowerCase());
    found.push({ ...item, species, score });
  }
  return found.sort((a, b) => b.score - a.score).slice(0, limit);
}
