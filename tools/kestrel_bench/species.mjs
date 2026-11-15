// The species the bench can make appear: the camera classifier's list for this home (classifier/species/atlanta.json: what a CAMERA can name) and
// BirdNET-Go's own list for this home (data/birdnet-go-labels.txt: what a MICROPHONE can name, "Scientific name_Common name" per line). The second file
// is a snapshot of the add-on's range-filter list (GET /api/v2/range/species/list, 244 species, 2026-11-14); it is read from disk, never fetched. To
// refresh it, save that list's `label` fields (one per line) over the file.
//
// The two lists name some animals differently, so an entry keeps both names: `heardAs` is what BirdNET-Go would send, `seenAs` what the camera
// classifier would say. Either one (or the scientific name) finds the entry.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const CLASSIFIER_SPECIES = join(here, "../../classifier/species/atlanta.json");
export const BIRDNET_LABELS = join(here, "data/birdnet-go-labels.txt");

/** The bench's group names are the plugin's: bird | mammal | other. `classOf` is the taxonomic class of a lowercased scientific name (taxonomy.ts). */
function groupOf(classOf, scientific) {
  switch (classOf(scientific.toLowerCase())) {
    case "Mammalia": return "mammal";
    case "Amphibia":
    case "Reptilia": return "other";
    case "Insecta": return "insect";
    default: return "bird";
  }
}

/** Every species the bench knows: [{ scientific, heardAs, seenAs, group, weight, sources }], most locally common first. `group` is "insect" for the calls the plugin drops. */
export function loadSpecies(classOf, { classifierFile = CLASSIFIER_SPECIES, labelsFile = BIRDNET_LABELS } = {}) {
  const byScientific = new Map();
  const entry = (scientific) => {
    const key = scientific.toLowerCase();
    let item = byScientific.get(key);
    if (!item) {
      item = { scientific, heardAs: null, seenAs: null, group: groupOf(classOf, scientific), weight: 0, sources: [] };
      byScientific.set(key, item);
    }
    return item;
  };
  for (const row of JSON.parse(readFileSync(classifierFile, "utf8"))) {
    const item = entry(row.scientific);
    item.seenAs = row.label;
    item.weight = Math.max(item.weight, Number(row.local_obs) || 0);
    item.sources.push("camera AI");
    if (row.group === "Mammals") item.group = "mammal";
  }
  for (const line of readFileSync(labelsFile, "utf8").split("\n")) {
    const [scientific, common] = line.trim().split("_");
    if (!scientific || !common) continue;
    const item = entry(scientific);
    item.heardAs = common;
    item.sources.push("BirdNET-Go");
  }
  return [...byScientific.values()].sort((a, b) => b.weight - a.weight || a.scientific.localeCompare(b.scientific));
}

/** The name BirdNET-Go would send / the camera classifier would say for an entry (each falls back to the other list's name). */
export const heardName = (item) => item.heardAs ?? item.seenAs;
export const seenName = (item) => item.seenAs ?? item.heardAs;

const plain = (text) => text.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * A few letters in, the best matches out. Every word you type has to start a word of some name (common or scientific), or at least sit inside one;
 * names that START with what you typed come first, then names with a word that does, then the rest; ties go to the animal this home sees most.
 */
export function searchSpecies(list, query, limit = 8) {
  const words = plain(query).split(" ").filter(Boolean);
  if (!words.length) return [];
  const scored = [];
  for (const item of list) {
    const names = [heardName(item), seenName(item), item.scientific].filter(Boolean).map(plain);
    let best = Infinity;
    for (const name of names) {
      const tokens = name.split(" ");
      let score = 0;
      for (const word of words) {
        if (name.startsWith(word)) score += 0;
        else if (tokens.some((token) => token.startsWith(word))) score += 1;
        else if (name.includes(word)) score += 3;
        else { score = Infinity; break; }
      }
      best = Math.min(best, score);
    }
    if (best < Infinity) scored.push({ item, best });
  }
  scored.sort((a, b) => a.best - b.best || b.item.weight - a.item.weight);
  return scored.slice(0, limit).map(({ item }) => item);
}

/** The one species a name stands for: an exact common or scientific name wins, else the best search match; undefined when nothing matches. */
export function findSpecies(list, query) {
  const wanted = plain(query);
  return list.find((item) => [heardName(item), seenName(item), item.scientific].some((name) => name && plain(name) === wanted)) ?? searchSpecies(list, query, 1)[0];
}
