// How common is this species around Atlanta at this time of year? Backs the "rare here" test
// for heard detections: the bundled table (seasonal-prior.ts, built from
// classifier/species/atlanta-weekly.json) says how common each species is in each of the
// year's 48 quarter-months.
// The table is passed in (callers hand it SEASONAL_PRIOR) so this module stays loadable by the
// plain-node tests, which only resolve extension-less imports for types.
import type { SeasonalEntry } from './seasonal-prior';

/** Commonness (0..1) below this means rare here this week. */
export const RARE_COMMONNESS = 0.15;
/** Fewer sightings than this and the quarter-month numbers are noise; commonness is damped. */
export const MIN_SIGHTINGS = 30;

// The table comes from iNaturalist photos, which badly undercount birds that are active
// only after dark. For these orders the prior says nothing, so only BirdNET-Go's own
// occurrence may call them rare. Perch can name species this region has never had, so
// this has to be decided by genus, not by looking the species up in the table.
const NOCTURNAL_GENERA: Readonly<Record<string, true>> = {
    // Strigiformes (owls)
    aegolius: true, asio: true, athene: true, bubo: true, ciccaba: true, glaucidium: true,
    gymnasio: true, gymnoglaux: true, ketupa: true, lophostrix: true, margarobyas: true,
    megascops: true, micrathene: true, ninox: true, nyctea: true, otus: true, phodilus: true,
    psiloscops: true, ptilopsis: true, pulsatrix: true, scotopelia: true, strix: true, surnia: true,
    tyto: true, xenoglaux: true,
    // Caprimulgiformes (nightjars and allies)
    aegotheles: true, antrostomus: true, batrachostomus: true, caprimulgus: true, chordeiles: true,
    eleothreptus: true, eurostopodus: true, hydropsalis: true, lurocalis: true, lyncornis: true,
    nyctibius: true, nyctidromus: true, nyctiphrynus: true, nyctiprogne: true, phalaenoptilus: true,
    podargus: true, setopagis: true, siphonorhis: true, steatornis: true, systellura: true,
    uropsalis: true,
};

const LOCAL_ZONE = 'America/New_York'; // the table is for Atlanta
const zoneParts = new Intl.DateTimeFormat('en-US', { timeZone: LOCAL_ZONE, month: 'numeric', day: 'numeric' });

/** 0..47: quarter-month of the local (Atlanta) date -- days 1-7, 8-14, 15-21, 22-end of each month. */
export function quarterMonthIndex(timeMs: number): number {
    let month = 1;
    let day = 1;
    for (const part of zoneParts.formatToParts(new Date(timeMs))) {
        if (part.type === 'month') month = Number(part.value);
        else if (part.type === 'day') day = Number(part.value);
    }
    return (month - 1) * 4 + Math.min(Math.floor((day - 1) / 7), 3);
}

/**
 * 0..1 rank of the species among those seen around Atlanta this quarter-month, or null when the
 * table has no opinion (no name, or an owl/nightjar). 0 = never seen here; 1 = always present
 * (domestic cat/dog). A species with fewer than MIN_SIGHTINGS is pulled toward 0.5 in proportion
 * to how little evidence there is and never drops below 0.25, so it cannot read as rare.
 */
export function commonnessFor(
    table: Readonly<Record<string, SeasonalEntry>>,
    scientificName: string | null | undefined,
    timeMs: number,
): number | null {
    const name = scientificName?.toLowerCase().trim().replace(/\s+/g, ' ');
    if (!name || Object.hasOwn(NOCTURNAL_GENERA, name.split(' ')[0])) return null;
    const entry = Object.hasOwn(table, name) ? table[name] : undefined;
    if (!entry) return 0;
    if (entry.always) return 1;
    const commonness = entry.pct[quarterMonthIndex(timeMs)] / 100;
    if (entry.obs >= MIN_SIGHTINGS) return commonness;
    return Math.max(0.25, 0.5 + (commonness - 0.5) * (entry.obs / MIN_SIGHTINGS));
}
