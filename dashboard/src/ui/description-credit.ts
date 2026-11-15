import { html, nothing } from "lit";
import type { DescriptionCredit } from "../facts.ts";

const link = (label: string, href: string | null) => (href ? html`<a href=${href} target="_blank" rel="noopener noreferrer">${label}</a>` : label);

/** The one caption line under a species' description ("From Wikipedia · CC BY-SA 4.0"): the source's name and its licence link to their pages when they have one.
 * Shown whenever the description is. The host's styles give it `.caption` (colour, size) and `.credit` (space above, long words wrap). */
export const descriptionCredit = (credit: DescriptionCredit) => html`<p class="caption credit">From ${link(credit.name, credit.url)}${credit.licence ? html` · ${link(credit.licence, credit.licenceUrl)}` : nothing}</p>`;
