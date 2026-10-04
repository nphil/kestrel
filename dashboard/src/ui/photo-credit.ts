import { html, nothing } from "lit";
import type { PhotoCredit } from "../types.ts";
import { photoCredit } from "../vocab.ts";

/** The one caption line under a reference photo ("Photo · Jane Birder · CC BY-NC · iNaturalist"), announced politely when it appears; the
 * source's name (the last part) is the link to its page. Nothing (and no space) until a credit is known. The host's styles give it
 * `.caption` (colour, size) and `.credit` (space above, long words wrap). */
export const photoCaption = (info: PhotoCredit | null) => {
  if (!info) return nothing;
  const text = photoCredit(info);
  return html`<p class="caption credit" role="status">${info.source && info.page ? html`${text.slice(0, -info.source.length)}<a href=${info.page} target="_blank" rel="noopener noreferrer">${info.source}</a>` : text}</p>`;
};
