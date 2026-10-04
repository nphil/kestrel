// What a BirdNET-Go detection means for Kestrel: which model said it, how sure Kestrel should really be (Likely /
// Possible / Check), and how the two models running side by side become ONE visit. It has no runtime dependencies
// on purpose (the store import is a type only, which is erased): main.ts imports it, and the tests import it directly
// without the Scrypted SDK, driving these same functions against a real store.
//
// Why this exists. BirdNET-Go now runs BirdNET v3.0 and Perch v2 on the same microphones. The decision taken after
// measuring them on 483 real clips (audio-eval/results.md) is: v3.0 makes the call, Perch is a second opinion only,
// scores are never merged, and a clip where the two name different birds (and either is at least 50% sure) is worth a
// person's tap. BirdNET-Go itself folds both models into ONE message when they name the same bird (the higher score
// wins and `Model` says whose it was), so Kestrel only ever sees two messages for one moment when the models DISAGREE.
//
// A call waits a few seconds before it becomes a visit, long enough for the other model's message to arrive; the
// second opinion waits a little longer than the main model so the main model's visit exists when it is looked for.

import type { HeardCallInput, HeardCallRow, KestrelStore, ModelCall, Tier, TierWhy, Visit } from './store';

export const REPEAT_WINDOW_MS = 5 * 60_000;
// The two models analyse the same audio and BirdNET-Go publishes both a few seconds after it: messages this close are one moment.
export const PAIR_WINDOW_MS = 20_000;
export const SETTLE_MS = 6_000;
export const SECOND_OPINION_SETTLE_MS = 9_000;
// The model whose word counts is the best one that has spoken at all in the last day, so retiring v3.0 (or Perch) later
// needs no change here.
export const PRIMARY_MODEL_MEMORY_MS = 24 * 60 * 60_000;
export const SCORE_STRONG = 0.8;
export const SCORE_GOOD = 0.6;
// A bird is rare here when BirdNET-Go's own chance of it this week (occurrence) is below RARE_OCCURRENCE, or local
// sightings say it is hardly ever seen at this time of year (commonness below RARE_COMMONNESS, the same value as in
// seasonal.ts, which heard.ts cannot import). One call of a rare bird is not enough.
export const RARE_OCCURRENCE = 0.1;
export const RARE_COMMONNESS = 0.15;
// The models name different birds and at least one of them is this sure.
export const DISAGREE_SCORE = 0.5;

export interface ModelInfo {
    key: string;
    label: string;
    // Whose word counts when models differ: the highest rank that has spoken is the main model.
    rank: number;
}

const MODEL_RANKS: Readonly<Record<string, number>> = { birdnet_v3: 3, perch_v2: 2, birdnet_v24: 1 };

export function rankOfModel(key: string | undefined): number {
    return (key && MODEL_RANKS[key]) || 0;
}

function text(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

// BirdNET-Go 20260823 sends the model as a nested object (`Model: { Name: 'Perch', Version: 'V2', Variant: 'default' }`);
// later builds send flat `modelName` / `modelVersion`. Both are read. A message with neither is an unrated source.
export function modelOf(message: Record<string, unknown>): ModelInfo {
    const nested = message.Model ?? message.model;
    const object = nested && typeof nested === 'object' ? nested as Record<string, unknown> : {};
    const name = text(object.Name ?? object.name ?? message.modelName ?? message.ModelName);
    const version = text(object.Version ?? object.version ?? message.modelVersion ?? message.ModelVersion);
    const lower = name.toLowerCase();
    if (lower.includes('perch')) return { key: 'perch_v2', label: `Perch ${version ? version.toLowerCase() : 'v2'}`, rank: rankOfModel('perch_v2') };
    if (lower.includes('birdnet')) {
        if (/^v?3/i.test(version)) return { key: 'birdnet_v3', label: 'BirdNET v3.0', rank: rankOfModel('birdnet_v3') };
        if (!version || /^v?2/i.test(version)) return { key: 'birdnet_v24', label: 'BirdNET v2.4', rank: rankOfModel('birdnet_v24') };
    }
    return { key: 'other', label: [name, version].filter(Boolean).join(' ') || 'BirdNET-Go', rank: 0 };
}

// BirdNET-Go's chance (0-1) that this species is here this week. It leaves the field out when it is 0, so a message
// without it is "not known", never "impossible".
export function occurrenceOf(message: Record<string, unknown>): number | null {
    const raw = message.occurrence ?? message.Occurrence;
    const value = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
    return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

// The one place that decides a bird is rare here: BirdNET-Go says it is unlikely this week, or local sightings say it
// is hardly ever seen this time of year. Unknown (null) is never rare.
export function isRareHere(occurrence: number | null | undefined, commonness?: number | null): boolean {
    return (typeof occurrence === 'number' && occurrence < RARE_OCCURRENCE) || (typeof commonness === 'number' && commonness < RARE_COMMONNESS);
}

export interface TierEvidence {
    // How sure the call is: the main model's score when it spoke, otherwise the best score anyone gave.
    score: number | null;
    // The main model named this species too (or no main model is running at all).
    corroborated: boolean;
    // Other calls of the same species on the same microphone within five minutes of the first.
    repeats: number;
    rare: boolean;
    // The second model named a different bird (see isDisagreement).
    disagrees: boolean;
    // Nothing that counts has ever recorded this species at home.
    newHere: boolean;
}

export interface TierDecision {
    tier: Tier;
    why: TierWhy[];
}

// Likely / Possible / Check, in plain rules:
//  - the models disagree                           -> Check
//  - only the second opinion heard it               -> Possible, or Check when the bird would be new or rare here
//  - a clear call (80%+), or a good one (60%+) heard again, of a bird that is not rare here
//    (a rare bird has to be heard three times)      -> Likely
//  - anything else                                  -> Check when the bird would be new or rare here, otherwise Possible
export function decideTier(evidence: TierEvidence): TierDecision {
    const score = evidence.score ?? 0;
    const heardAgain = evidence.repeats >= 1;
    const clear = score >= SCORE_STRONG;
    const strong = clear || (score >= SCORE_GOOD && heardAgain);
    if (evidence.disagrees) return { tier: 'check', why: ['models_disagree'] };
    const worthALook = evidence.newHere || evidence.rare;
    const context: TierWhy[] = [...(evidence.rare ? ['rare_here' as const] : []), ...(evidence.newHere ? ['new_here' as const] : [])];
    if (!evidence.corroborated) return { tier: worthALook ? 'check' : 'possible', why: ['second_opinion_only', ...context] };
    if (strong && !(evidence.rare && evidence.repeats < 2)) return { tier: 'likely', why: [clear ? 'strong' : 'repeated', ...(clear && heardAgain ? ['repeated' as const] : [])] };
    if (worthALook) return { tier: 'check', why: [evidence.rare ? 'rare_here' : 'weak', ...(evidence.rare && !strong ? ['weak' as const] : []), ...(evidence.newHere ? ['new_here' as const] : [])] };
    return { tier: 'possible', why: ['weak'] };
}

// The second model names a different bird and at least one of the two is sure enough to matter.
export function isDisagreement(named: Pick<ModelCall, 'species' | 'score'>, other: Pick<ModelCall, 'species' | 'score'>): boolean {
    return named.species !== other.species && Math.max(named.score ?? 0, other.score ?? 0) >= DISAGREE_SCORE;
}

export type HeardStore = Pick<KestrelStore,
    'recordHeardCall' | 'getHeardCall' | 'heardCallsNear' | 'attachHeardCall' | 'primaryModelRank' | 'noteModelSeen' | 'countHeardCalls'
    | 'findRecentHeardVisit' | 'findHeardVisitsNear' | 'hasSpecies' | 'getVisit' | 'saveVisit' | 'recomputeFirstEverForSpecies'>;

export interface HeardPorts {
    store: HeardStore;
    cooldownMs(): number;
    // The camera's name, or undefined when it is no longer watched (its calls are then ignored).
    cameraName(cameraId: string): string | undefined;
    isMuted(species: string): boolean;
    usualSuggestions(cameraId: string, species: string): Visit['suggestions'];
    // How common local sightings say this species is at this time of year (0-1), when known.
    commonness?(scientific: string | null, at: number): number | null;
    newId(): string;
    // A call made a new visit (already saved): announce it.
    created(visit: Visit): void;
    // A visit changed (its tier, its review flag, what the other model said): announce it.
    updated(visit: Visit): void;
    // A visit that counts: link it to a camera sighting of the same moment (link.ts).
    link(visit: Visit): void;
    failed?(error: unknown): void;
}

function asModelCall(call: HeardCallRow, role: ModelCall['role']): ModelCall {
    return { model: call.model, label: call.modelLabel, species: call.species, score: call.score, role };
}

// Adds a call to the list of what the models said, one entry per model and species (the better score stays).
function recordModelCall(models: ModelCall[], entry: ModelCall): void {
    const same = models.find(item => item.model === entry.model && item.species === entry.species);
    if (!same) models.push(entry);
    else if ((entry.score ?? -1) > (same.score ?? -1)) same.score = entry.score;
}

// The model that named a visit (its first entry); undefined for a visit from before the confidence layer.
function namedModel(visit: Visit): string | undefined {
    return visit.models?.find(item => item.role === 'named')?.model;
}

// The evidence for a visit from what its models said. With a main model running, only a call it made corroborates a
// bird and only its score counts; with none, the best call counts.
function evidenceFor(visit: Visit, models: readonly ModelCall[], primaryRank: number, newHere: boolean): TierEvidence {
    const ofSpecies = models.filter(item => item.species === visit.species);
    const main = ofSpecies.filter(item => rankOfModel(item.model) >= primaryRank);
    const scores = (main.length ? main : ofSpecies).map(item => item.score).filter((score): score is number => score !== null);
    const named = models.find(item => item.role === 'named');
    const other = models.find(item => item.role === 'other');
    const corroborated = primaryRank <= 0 || main.length > 0;
    return {
        score: scores.length ? Math.max(...scores) : null,
        corroborated,
        repeats: visit.repeats ?? 0,
        rare: isRareHere(visit.occurrence, visit.commonness),
        disagrees: !!named && !!other && corroborated && isDisagreement(named, other),
        newHere,
    };
}

// What the dashboards would notice: when it changes the visit is announced again.
function snapshot(visit: Visit): { signature: string; likely: boolean } {
    const models = (visit.models ?? []).map(item => [item.model, item.species, item.role, item.score === null ? null : Math.round(item.score * 100)]);
    return { signature: JSON.stringify([visit.tier, visit.tierWhy, visit.review, visit.firstEver, visit.species, models]), likely: visit.tier === 'likely' };
}

export class HeardIngest {
    private readonly ports: HeardPorts;
    private pending: { id: number; dueAt: number }[] = [];

    constructor(ports: HeardPorts) {
        this.ports = ports;
    }

    // Which model a message came from, remembered even when the message makes no call (an insect, an unwatched
    // microphone): it is what tells the main model from a second opinion.
    noteModel(model: string, rank: number, at: number): void {
        this.ports.store.noteModelSeen(model, rank, at);
    }

    // A detection arrived. It is kept at once (so repeats can be counted and the other model can find it) and becomes a
    // visit on a later flush, once the other model has had its say.
    receive(call: HeardCallInput): void {
        const store = this.ports.store;
        store.noteModelSeen(call.model, call.modelRank, call.receivedAt);
        const id = store.recordHeardCall(call);
        if (id === undefined) return;
        const secondOpinion = call.modelRank < store.primaryModelRank(call.receivedAt - PRIMARY_MODEL_MEMORY_MS);
        this.pending.push({ id, dueAt: call.receivedAt + (secondOpinion ? SECOND_OPINION_SETTLE_MS : SETTLE_MS) });
    }

    // Turns every call whose wait is over into a visit (or into evidence on one). The main model's calls go first, and a
    // second opinion never goes ahead of a main-model call for the same moment that is still waiting.
    flush(now: number): void {
        const due = this.pending.filter(item => item.dueAt <= now);
        if (!due.length) return;
        this.pending = this.pending.filter(item => item.dueAt > now);
        const primaryRank = this.ports.store.primaryModelRank(now - PRIMARY_MODEL_MEMORY_MS);
        const rows = due.map(item => this.ports.store.getHeardCall(item.id)).filter((row): row is HeardCallRow => !!row);
        rows.sort((a, b) => b.modelRank - a.modelRank || a.at - b.at || a.id - b.id);
        for (const row of rows) {
            try {
                const waitUntil = row.modelRank < primaryRank ? this.mainCallDueAt(row, primaryRank) : undefined;
                if (waitUntil !== undefined) this.pending.push({ id: row.id, dueAt: waitUntil + 1 });
                else this.handle(row.id, primaryRank);
            } catch (error) {
                this.ports.failed?.(error);
            }
        }
    }

    // When the main model's call for this second opinion's moment is due, if that call is still waiting to be handled.
    private mainCallDueAt(call: HeardCallRow, primaryRank: number): number | undefined {
        let dueAt: number | undefined;
        for (const item of this.pending) {
            const other = this.ports.store.getHeardCall(item.id);
            if (other && !other.visitId && other.cameraId === call.cameraId && other.modelRank >= primaryRank && Math.abs(other.at - call.at) <= PAIR_WINDOW_MS)
                dueAt = Math.max(dueAt ?? 0, item.dueAt);
        }
        return dueAt;
    }

    private handle(callId: number, primaryRank: number): void {
        const { store } = this.ports;
        const call = store.getHeardCall(callId);
        if (!call || call.visitId) return;
        // The same bird again inside the cooldown is more evidence for the visit it already has, never a new visit.
        const existing = store.findRecentHeardVisit(call.cameraId, call.species, call.at - this.ports.cooldownMs());
        if (existing) {
            this.foldRepeat(existing, call, primaryRank);
            return;
        }
        // A second opinion that names a different bird belongs to the visit the main model made for that moment.
        if (call.modelRank < primaryRank) {
            const named = store.findHeardVisitsNear(call.cameraId, call.at, PAIR_WINDOW_MS)
                .find(visit => visit.species !== call.species && rankOfModel(namedModel(visit)) >= primaryRank);
            if (named) {
                this.recordDisagreement(named, call, primaryRank);
                return;
            }
        }
        this.createVisit(call, primaryRank);
    }

    private createVisit(call: HeardCallRow, primaryRank: number): void {
        const { store } = this.ports;
        const cameraName = this.ports.cameraName(call.cameraId);
        if (!cameraName) return;
        // The main model has spoken for a moment a second opinion already turned into a visit of a different bird (the
        // second opinion came first and the main model later than the wait): that visit becomes the main model's.
        if (call.modelRank >= primaryRank) {
            const early = store.findHeardVisitsNear(call.cameraId, call.at, PAIR_WINDOW_MS)
                .find(visit => visit.status === 'auto' && visit.tier !== undefined && visit.tier !== 'likely' && visit.species !== call.species
                    && namedModel(visit) !== undefined && rankOfModel(namedModel(visit)) < primaryRank);
            if (early) {
                this.retarget(early, call, primaryRank);
                return;
            }
        }
        // Other models' calls of the same moment that no visit has taken yet.
        const companions = store.heardCallsNear(call.cameraId, call.at - PAIR_WINDOW_MS, call.at + PAIR_WINDOW_MS)
            .filter(item => item.id !== call.id && !item.visitId && item.model !== call.model);
        const models: ModelCall[] = [asModelCall(call, 'named')];
        for (const item of companions) recordModelCall(models, asModelCall(item, item.species === call.species ? 'agree' : 'other'));
        const id = this.ports.newId();
        const newHere = !store.hasSpecies(call.species);
        const visit: Visit = {
            id, camera: { id: call.cameraId, name: cameraName }, kind: 'heard', startedAt: call.at, species: call.species, grp: call.grp,
            status: 'auto', score: call.score, snapshot: null, crop: null, clip: { state: 'none', expectedReadyAt: null }, heard: null,
            audio: call.detectionId !== null || call.clip !== null ? { birdnetDetectionId: call.detectionId, birdnetClip: call.clip } : null,
            suggestions: [], firstEver: false, muted: this.ports.isMuted(call.species), notify: false,
            occurrence: call.occurrence, commonness: this.ports.commonness?.(call.scientific, call.at) ?? null,
            repeats: store.countHeardCalls(call.cameraId, call.species, call.at - REPEAT_WINDOW_MS, call.at, call.id), models,
        };
        const decision = decideTier(evidenceFor(visit, models, primaryRank, newHere));
        visit.tier = decision.tier;
        visit.tierWhy = decision.why;
        visit.review = decision.tier === 'check';
        visit.firstEver = decision.tier === 'likely' && newHere;
        visit.suggestions = this.suggestionsFor(visit, models);
        store.saveVisit(visit, { birdnetDetectionId: call.detectionId, birdnetClip: call.clip, review: visit.review });
        store.attachHeardCall(call.id, id);
        for (const item of companions) store.attachHeardCall(item.id, id);
        if (decision.tier === 'likely') this.ports.link(visit);
        this.ports.created(store.getVisit(id) ?? visit);
    }

    // The same bird again: more evidence for the visit it already has (and, once the main model says it too, for its tier).
    private foldRepeat(visit: Visit, call: HeardCallRow, primaryRank: number): void {
        this.ports.store.attachHeardCall(call.id, visit.id);
        // A person has already decided this visit, or it is from before the confidence layer and stays unrated: the call
        // is remembered, the visit is left exactly as it is.
        if (visit.status !== 'auto' || !visit.tier) return;
        const before = snapshot(visit);
        const models = visit.models ?? [];
        recordModelCall(models, asModelCall(call, 'agree'));
        visit.models = models;
        if (call.at > visit.startedAt && call.at - visit.startedAt <= REPEAT_WINDOW_MS) visit.repeats = (visit.repeats ?? 0) + 1;
        this.retier(visit, primaryRank);
        this.finish(visit, before);
    }

    // The second model named a different bird for the moment of a visit the main model made.
    private recordDisagreement(visit: Visit, call: HeardCallRow, primaryRank: number): void {
        this.ports.store.attachHeardCall(call.id, visit.id);
        if (visit.status !== 'auto') return;
        const before = snapshot(visit);
        const models = visit.models ?? [];
        recordModelCall(models, asModelCall(call, 'other'));
        visit.models = models;
        if (!visit.suggestions.some(item => item.species === call.species)) visit.suggestions = [{ species: call.species, why: 'model' }, ...visit.suggestions];
        this.retier(visit, primaryRank);
        this.finish(visit, before);
    }

    // The main model's call for a moment a second opinion had already turned into a visit of a different bird: the visit
    // is renamed to the main model's bird and the second opinion stays as what the other model said. Nobody was told about
    // that visit as news (a call only the second model heard is never announced), so nothing needs taking back.
    private retarget(visit: Visit, call: HeardCallRow, primaryRank: number): void {
        const before = snapshot(visit);
        const previousSpecies = visit.species;
        const secondOpinion = visit.models?.find(item => item.role === 'named');
        const models: ModelCall[] = [asModelCall(call, 'named'), ...(secondOpinion ? [{ ...secondOpinion, role: 'other' as const }] : [])];
        visit.species = call.species;
        visit.grp = call.grp;
        visit.score = call.score;
        visit.audio = call.detectionId !== null || call.clip !== null ? { birdnetDetectionId: call.detectionId, birdnetClip: call.clip } : null;
        visit.occurrence = call.occurrence;
        visit.commonness = this.ports.commonness?.(call.scientific, call.at) ?? null;
        visit.muted = this.ports.isMuted(call.species);
        visit.models = models;
        visit.suggestions = this.suggestionsFor(visit, models);
        this.ports.store.attachHeardCall(call.id, visit.id);
        this.retier(visit, primaryRank);
        this.finish(visit, before, { birdnetDetectionId: call.detectionId, birdnetClip: call.clip });
        this.ports.store.recomputeFirstEverForSpecies(previousSpecies);
    }

    // A fresh tier from the evidence a visit has now. Evidence only adds up: a Likely visit stays Likely unless the models
    // now disagree, so a quiet minute never takes a tier away.
    private retier(visit: Visit, primaryRank: number): void {
        const evidence = evidenceFor(visit, visit.models ?? [], primaryRank, !this.ports.store.hasSpecies(visit.species));
        if (visit.tier === 'likely' && !evidence.disagrees) return;
        const previous = visit.tier;
        const decision = decideTier(evidence);
        visit.tier = decision.tier;
        visit.tierWhy = decision.why;
        if (decision.tier === 'check') visit.review = true;
        else if (previous === 'check') visit.review = false;
    }

    // Saves a changed visit, fixes the first-ever flag when it started or stopped counting, links it when it now counts,
    // and tells the dashboards only when something they show changed (a plain extra repeat is saved quietly).
    private finish(visit: Visit, before: { signature: string; likely: boolean }, files: { birdnetDetectionId?: number | null; birdnetClip?: string | null } = {}): void {
        const { store } = this.ports;
        store.saveVisit(visit, { ...files, review: !!visit.review });
        const likely = visit.tier === 'likely';
        if (likely !== before.likely) store.recomputeFirstEverForSpecies(visit.species);
        const saved = store.getVisit(visit.id) ?? visit;
        if (likely && !before.likely) this.ports.link(saved);
        const current = store.getVisit(visit.id) ?? saved;
        if (snapshot(current).signature !== before.signature) this.ports.updated(current);
    }

    // What the picker offers for this visit: a model that named something else first, then the birds confirmed here.
    private suggestionsFor(visit: Visit, models: readonly ModelCall[]): Visit['suggestions'] {
        const suggestions: Visit['suggestions'] = [];
        for (const item of models)
            if (item.role === 'other' && !suggestions.some(existing => existing.species === item.species)) suggestions.push({ species: item.species, why: 'model' });
        for (const item of this.ports.usualSuggestions(visit.camera.id, visit.species))
            if (item.species !== visit.species && !suggestions.some(existing => existing.species === item.species)) suggestions.push(item);
        return suggestions;
    }
}
