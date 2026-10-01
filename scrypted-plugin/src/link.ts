// Links a seen visit and a heard visit of the same species on the same camera, and puts a seen and
// a heard visit that disagree on the review list. Moved out of main.ts unchanged so the unit tests
// run the real code. It has no runtime dependencies on purpose (the store import is a type only,
// which is erased): main.ts imports it, and the tests import it directly without the Scrypted SDK.
import type { KestrelStore, Visit } from './store';

// What linking needs from the store; KestrelStore satisfies it as is.
export type LinkStore = Pick<KestrelStore, 'findHeardOrSeen' | 'getVisit' | 'getRawVisit' | 'saveVisit'>;

// `visit` has just been recorded (seen or heard). A visit of the other kind on the same camera
// within the window findHeardOrSeen uses (two minutes either side) is linked to it when it has the
// same species, and both go to the review list when it has a different one. `publishUpdated`
// announces every OTHER visit this touched; the caller announces `visit` itself.
export function linkSeenAndHeard(store: LinkStore, visit: Visit, publishUpdated: (visit: Visit) => void): void {
    const matches = store.findHeardOrSeen(visit.camera.id, visit.species, visit.kind, visit.startedAt);
    const exact = matches.find(row => row.species === visit.species);
    const disagreements = matches.filter(row => row.species !== visit.species);
    if (exact) {
        const other = store.getVisit(exact.id);
        if (other && visit.kind === 'seen') {
            const heardRaw = store.getRawVisit(other.id);
            visit.heard = { visitId: other.id, species: other.species, hasAudio: heardRaw?.birdnet_detection_id != null,
                birdnetDetectionId: heardRaw?.birdnet_detection_id ?? null, birdnetClip: heardRaw?.birdnet_clip ?? null };
            visit.suggestions.push({ species: other.species, why: 'heard' });
            store.saveVisit(visit);
            publishUpdated(other);
        } else if (other && visit.kind === 'heard' && other.kind === 'seen') {
            const heardRaw = store.getRawVisit(visit.id);
            other.heard = { visitId: visit.id, species: visit.species, hasAudio: heardRaw?.birdnet_detection_id != null,
                birdnetDetectionId: heardRaw?.birdnet_detection_id ?? null, birdnetClip: heardRaw?.birdnet_clip ?? null };
            other.suggestions.push({ species: visit.species, why: 'heard' });
            store.saveVisit(other);
            publishUpdated(other);
        }
    }
    if (disagreements.length) {
        visit.review = true;
        store.saveVisit(visit, { review: true });
        for (const row of disagreements) {
            const other = store.getVisit(row.id);
            if (!other) continue;
            other.review = true;
            store.saveVisit(other, { review: true });
            publishUpdated(other);
        }
    }
}
