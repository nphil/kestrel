import { Lru } from "./lru.ts";
import type { SwrSnapshot } from "lucent-ha";

/** The last answer to each question a card asked, with the text it says. Few questions exist (one per period and card setting), so a small bound is plenty. */
const LAST = new Lru<string, { text: string; data: unknown }>(16);

/** `data`, or, when it says exactly what the last answer to `key` said, that last answer itself.
 *
 * Every answer from the server is a new object, even when nothing in it changed, and a card draws again for a new object. Handing back the
 * one already drawn makes "the same again" something the card can see by `===`. The pictures' links are already steady (`stableUrl`), so a
 * repeated answer really does read the same. */
export function steadyAnswer<Data>(key: string, data: Data): Data {
  let text: string | undefined;
  try {
    text = JSON.stringify(data);
  } catch {
    return data; // not plain data: nothing to compare, treat it as new
  }
  if (text === undefined) return data;
  const last = LAST.get(key);
  if (last && last.text === text) return last.data as Data;
  LAST.set(key, { text, data });
  return data;
}

/** The `hasChanged` of a card's snapshot. A card draws the answer, or that asking failed, and nothing else; the toolkit's snapshot is a new
 * object after every step of an ask ("loading", then "confirmed at ...") and none of that is on the card. */
export function drawnDifferently(next: SwrSnapshot<unknown> | undefined, previous: SwrSnapshot<unknown> | undefined): boolean {
  return next?.data !== previous?.data || (next?.error !== undefined) !== (previous?.error !== undefined);
}
