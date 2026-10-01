// Same-moment grouping for "seen" (camera) visits, plus the clip-start tolerance that lets a
// merged visit still find its Events Recorder clip. It has no runtime dependencies on purpose
// (the store imports below are types only, which are erased): main.ts imports it, and the unit
// tests import it directly without the Scrypted SDK, driving these same functions against a store.
//
// Why this exists: one animal can be reported at the same instant as two detections with different
// tracker ids and different labels (a raccoon scored "Common Raccoon" 0.84 and, 0.75 s later,
// "Southern Flying Squirrel" 0.82). The per-species cooldown treats those as two species, so Kestrel
// made two visits -- and the Events Recorder clip, which began between the two start times, linked
// to only one of them. Detections of one animal at one moment are one visit, whatever they are
// labelled; the loser's label is kept as a suggestion.

import type { SeenMergeUpdate, Visit, VisitGroup } from './store';

export const SAME_MOMENT_WINDOW_MS = 5_000;
// Events Recorder starts a clip a moment AFTER the detection that triggered it (555 ms in the
// raccoon incident), so a clip that begins shortly after the visit's start still covers it.
export const CLIP_START_TOLERANCE_MS = 5_000;
export const UNIDENTIFIED_ANIMAL = 'Unidentified animal';

export type Suggestion = { species: string; why: 'model' | 'heard' | 'usual' };
export type MergeStatus = 'auto' | 'learned' | 'corrected' | 'confirmed' | 'not_animal' | 'unknown';

export interface ExistingSeen {
    species: string;
    score: number | null;
    startedAt: number;
    status: MergeStatus;
    suggestions: Suggestion[];
}

export interface IncomingSeen {
    species: string;
    score: number | null;
    startedAt: number;
    status: 'auto' | 'learned';
    detectionLabel: string;
}

export interface SeenMergePlan {
    // False when merging teaches the visit nothing (the caller then leaves it alone, no event).
    changed: boolean;
    // The incoming detection supplies the visit's score (and photo); see replaceMedia.
    incomingWins: boolean;
    // Overwrite the visit's snapshot + crop with the incoming capture (it has the higher score).
    replaceMedia: boolean;
    speciesChanged: boolean;
    species: string;
    score: number | null;
    status: MergeStatus;
    // The earliest detection of the merged group.
    startedAt: number;
    // New raw model label when the species changed, otherwise null (keep the stored one).
    detectionLabel: string | null;
    // 'model'/'heard'/'usual' suggestions after the merge; never contains `species`. When the
    // species changed the caller replaces the 'usual' ones and re-links 'heard' ones.
    suggestions: Suggestion[];
}

const USER_DECIDED: ReadonlySet<string> = new Set(['corrected', 'confirmed', 'not_animal', 'unknown']);

function rank(score: number | null): number {
    return score ?? Number.NEGATIVE_INFINITY;
}

// Puts `species` in the list as a 'model' suggestion (the other label the detector produced),
// removing any other entry for it and anything equal to the visit's own species.
function addModelSuggestion(list: Suggestion[], species: string, own: string): Suggestion[] {
    const rest = list.filter(item => item.species !== species && item.species !== own);
    if (species === own || species === UNIDENTIFIED_ANIMAL)
        return list.filter(item => item.species !== own);
    return [
        ...rest.filter(item => item.why === 'model'),
        { species, why: 'model' },
        ...rest.filter(item => item.why !== 'model'),
    ];
}

function sameSuggestions(a: Suggestion[], b: Suggestion[]): boolean {
    return a.length === b.length && a.every((item, index) => item.species === b[index].species && item.why === b[index].why);
}

// Decides what happens when a detection arrives for a moment an existing seen visit already
// covers. Higher score keeps the species (ties go to the earlier detection); the other label
// becomes a 'model' suggestion; a better score also supplies the photo. An "Unidentified animal"
// never beats a real label and is never offered as a suggestion. A visit a person has already
// corrected/confirmed is left exactly as they decided.
export function planSeenMerge(existing: ExistingSeen, incoming: IncomingSeen): SeenMergePlan {
    const startedAt = Math.min(existing.startedAt, incoming.startedAt);
    const base = existing.suggestions.filter(item => item.species !== existing.species);
    const keep: SeenMergePlan = {
        changed: startedAt !== existing.startedAt,
        incomingWins: false, replaceMedia: false, speciesChanged: false,
        species: existing.species, score: existing.score, status: existing.status, startedAt,
        detectionLabel: null, suggestions: base,
    };
    if (USER_DECIDED.has(existing.status))
        return { ...keep, changed: false, startedAt: existing.startedAt, suggestions: existing.suggestions };

    const incomingScore = rank(incoming.score);
    const existingScore = rank(existing.score);
    const higher = incomingScore > existingScore;
    const tieEarlier = incomingScore === existingScore && incoming.startedAt < existing.startedAt;
    const incomingLabeled = incoming.species !== UNIDENTIFIED_ANIMAL;
    const existingLabeled = existing.species !== UNIDENTIFIED_ANIMAL;

    // Same species (or two unidentified): nothing to relabel; a better score upgrades the photo.
    if (incoming.species === existing.species || (!incomingLabeled && !existingLabeled)) {
        if (higher) return { ...keep, changed: true, incomingWins: true, replaceMedia: true, score: incoming.score };
        return keep;
    }
    // An unidentified detection has no label to contribute to a labelled visit.
    if (!incomingLabeled) return keep;

    const incomingWins = !existingLabeled || higher || tieEarlier;
    if (incomingWins) {
        return {
            changed: true, incomingWins: true, replaceMedia: true, speciesChanged: true,
            species: incoming.species, score: incoming.score, status: incoming.status, startedAt,
            detectionLabel: incoming.detectionLabel,
            suggestions: addModelSuggestion(base.filter(item => item.species !== incoming.species), existing.species, incoming.species),
        };
    }
    const suggestions = addModelSuggestion(base, incoming.species, existing.species);
    return { ...keep, changed: keep.changed || !sameSuggestions(base, suggestions), suggestions };
}

// Remembers, per camera, which seen visit an animal is currently "inside" so label flips
// during a long stay fold into it. The window slides: every animal detection near the visit
// extends it, but never past `maxSpanMs` from the visit's start (the species cooldown takes over
// after that, exactly as before). One entry per camera, so it cannot grow.
export class SameMomentTracker {
    private readonly active = new Map<string, { visitId: string; firstAt: number; lastAt: number }>();

    private readonly windowMs: number;

    constructor(windowMs: number = SAME_MOMENT_WINDOW_MS) {
        this.windowMs = windowMs;
    }

    remember(cameraId: string, visitId: string, startedAt: number, at: number = startedAt): void {
        const current = this.active.get(cameraId);
        if (current && current.visitId === visitId) {
            current.firstAt = Math.min(current.firstAt, startedAt);
            current.lastAt = Math.max(current.lastAt, at);
            return;
        }
        this.active.set(cameraId, { visitId, firstAt: startedAt, lastAt: Math.max(startedAt, at) });
    }

    touch(cameraId: string, at: number, maxSpanMs: number): void {
        const current = this.active.get(cameraId);
        if (!current || !this.covers(current, at)) return;
        if (at - current.firstAt <= maxSpanMs) current.lastAt = Math.max(current.lastAt, at);
    }

    find(cameraId: string, at: number): string | undefined {
        const current = this.active.get(cameraId);
        return current && this.covers(current, at) ? current.visitId : undefined;
    }

    private covers(entry: { firstAt: number; lastAt: number }, at: number): boolean {
        return at >= entry.firstAt - this.windowMs && at <= entry.lastAt + this.windowMs;
    }
}

// Does a recorded clip cover the moment a visit started? The clip may begin up to
// CLIP_START_TOLERANCE_MS after the visit's start and still be its clip.
export function clipCoversVisitStart(clipStart: number, clipEnd: number, visitStartedAt: number): boolean {
    return clipStart <= visitStartedAt + CLIP_START_TOLERANCE_MS && clipEnd >= visitStartedAt;
}

// --- Committing a detection -------------------------------------------------------------------
// main.ts runs decideSeenCommit and then mergeSeenDetection for every animal detection that has a
// label (or has waited out the unidentified grace period). The unit tests call these same
// functions, so the order of the checks below is tested rather than copied.

// What the decision reads from the store; KestrelStore satisfies it as is.
export interface SeenLookup {
    getVisit(id: string): Visit | undefined;
    findSeenNear(cameraId: string, at: number, windowMs: number): Visit | undefined;
    findRecentSeenVisit(cameraId: string, species: string, since: number): Visit | undefined;
}

export type SeenCommitDecision =
    // The same animal at the same moment: fold the detection into this visit.
    | { action: 'merge'; target: Visit }
    // The species was already SEEN on this camera inside the cooldown: nothing to do. (A call that
    // was only heard does not count; the seen visit is created and linked to it.)
    | { action: 'skip' }
    // A genuinely new visit.
    | { action: 'create' };

function findSameMomentVisit(lookup: SeenLookup, tracker: SameMomentTracker, cameraId: string, at: number): Visit | undefined {
    const trackedId = tracker.find(cameraId, at);
    const tracked = trackedId ? lookup.getVisit(trackedId) : undefined;
    if (tracked && tracked.kind === 'seen' && tracked.camera.id === cameraId) return tracked;
    return lookup.findSeenNear(cameraId, at, SAME_MOMENT_WINDOW_MS);
}

// The same-moment check comes first: the cooldown is per species, so on its own it calls a second
// label for the same animal a different visit (which is the bug this check exists to prevent).
export function decideSeenCommit(
    lookup: SeenLookup,
    tracker: SameMomentTracker,
    cooldownMs: number,
    detection: { cameraId: string; startedAt: number; species: string },
): SeenCommitDecision {
    const target = findSameMomentVisit(lookup, tracker, detection.cameraId, detection.startedAt);
    if (target) return { action: 'merge', target };
    if (lookup.findRecentSeenVisit(detection.cameraId, detection.species, detection.startedAt - cooldownMs)) return { action: 'skip' };
    return { action: 'create' };
}

// What the merge needs besides the store.
export interface SeenMergePorts {
    store: { applySeenMerge(visitId: string, update: SeenMergeUpdate): Visit | undefined };
    tracker: SameMomentTracker;
    groupFor(species: string): VisitGroup;
    usualSuggestions(cameraId: string, species: string): Suggestion[];
    isMuted(species: string): boolean;
}

export interface SeenMergeResult {
    // The visit after the merge (the target itself when nothing changed).
    visit: Visit;
    plan: SeenMergePlan;
    // True when the stored visit changed. The caller then rewrites the photo if plan.replaceMedia,
    // re-links a heard call if plan.speciesChanged, and publishes visit_updated.
    changed: boolean;
}

export function mergeSeenDetection(ports: SeenMergePorts, target: Visit, incoming: IncomingSeen): SeenMergeResult {
    const plan = planSeenMerge(target, incoming);
    // The animal is still here: later detections of it also belong to this visit.
    ports.tracker.remember(target.camera.id, target.id, Math.min(target.startedAt, incoming.startedAt), incoming.startedAt);
    if (!plan.changed) return { visit: target, plan, changed: false };
    const updated = ports.store.applySeenMerge(target.id, {
        species: plan.species,
        speciesChanged: plan.speciesChanged,
        grp: plan.speciesChanged ? ports.groupFor(plan.species) : target.grp,
        status: plan.status,
        score: plan.score,
        startedAt: plan.startedAt,
        suggestions: plan.suggestions,
        usual: plan.speciesChanged ? ports.usualSuggestions(target.camera.id, plan.species) : [],
        detectionLabel: plan.detectionLabel,
        muted: plan.speciesChanged ? ports.isMuted(plan.species) : target.muted,
    });
    return updated ? { visit: updated, plan, changed: true } : { visit: target, plan, changed: false };
}

// Runs tasks one at a time per key, in the order they were queued: two detections of the same
// animal on one camera must not both decide "no visit yet" and each create one. A task that fails
// does not block the next, and a key with nothing queued is forgotten, so the map cannot grow.
export class KeyedQueue {
    private readonly tails = new Map<string, Promise<void>>();

    get queuedKeys(): number {
        return this.tails.size;
    }

    run<T>(key: string, task: () => Promise<T>): Promise<T> {
        const previous = this.tails.get(key) ?? Promise.resolve();
        const result = previous.then(task);
        const tail = result.then(() => undefined, () => undefined);
        this.tails.set(key, tail);
        void tail.then(() => { if (this.tails.get(key) === tail) this.tails.delete(key); });
        return result;
    }
}
