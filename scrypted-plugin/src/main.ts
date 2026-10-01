import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import type { HttpRequest, HttpRequestHandler, HttpResponse, Setting, Settings, SettingValue, VideoClip, VideoClips } from '@scrypted/sdk';
import { ScryptedDeviceBase, ScryptedInterface } from '@scrypted/sdk';
import mqtt, { type MqttClient } from 'mqtt';
import { ChangeGate } from './changes';
import { chooseLearnedLabel, embeddingFromBuffer, type LearningExample } from './learning';
import { linkSeenAndHeard } from './link';
import { parseLongPollTimeoutMs } from './longpoll';
import { captureDetection, embedCrop, ensureMediaDirectories, saveCapture } from './media';
import { KeyedQueue, SameMomentTracker, clipCoversVisitStart, decideSeenCommit, mergeSeenDetection } from './seen';
import { KestrelStore, type EventItem, type EventsResponse, type Visit, type VisitGroup, type VisitKind, type VisitStatus } from './store';
import { sdk } from './sdkFix';
import { SPECIES_GROUPS } from './species-groups';
import { GENUS_CLASS, SPECIES_CLASS } from './taxonomy';

const CAMERA_SETTING = 'cameras';
const DEFAULT_CAMERAS = ['88', '103', '104', '106'];
const DEFAULT_BROKER = 'mqtt://192.168.1.146:1883';
const DEFAULT_TOPIC = 'birdnet';
const DEFAULT_COOLDOWN_MINUTES = 10;
const UNIDENTIFIED_GRACE_MS = 30_000;
const CLIP_EXPECTED_DELAY_MS = 45_000;
const CLIP_GIVE_UP_MS = 5 * 60_000;
const CLIP_POLL_MS = 5_000;
const MEDIA_BUDGET_BYTES = 300 * 1024 * 1024;
const MAX_LONG_POLLS = 100;
const DETECTOR_SESSION_IDLE_MS = 3_000;
const USUAL_SUGGESTIONS_WINDOW_MS = 30 * 24 * 60 * 60_000;
const USUAL_SUGGESTIONS_LIMIT = 5;
const SETTINGS: Setting[] = [
    { key: CAMERA_SETTING, title: 'Wildlife cameras', description: 'Select Scrypted cameras for animal detections and BirdNET matching.', type: 'device', deviceFilter: 'VideoCamera', multiple: true },
    { key: 'cooldownMinutes', title: 'Species cooldown (minutes)', description: 'Minimum interval between visits for the same species on one camera.', type: 'number', value: DEFAULT_COOLDOWN_MINUTES },
    { key: 'brokerUrl', title: 'BirdNET MQTT broker URL', type: 'string', value: DEFAULT_BROKER },
    { key: 'username', title: 'BirdNET MQTT username', type: 'string' },
    { key: 'password', title: 'BirdNET MQTT password', type: 'password' },
    { key: 'birdnetTopic', title: 'BirdNET MQTT topic', description: 'The plugin subscribes to this topic and its subtopics.', type: 'string', value: DEFAULT_TOPIC },
    { key: 'birdnetCameraMap', title: 'BirdNET source-to-camera map (JSON)', description: 'Optional object mapping BirdNET source names to Scrypted camera IDs.', type: 'textarea', value: '{}' },
    { key: 'apiKey', title: 'Kestrel API key (copy into Home Assistant)', type: 'string', readonly: true },
];

type Detection = { className?: string; label?: string | null; score?: number | null; id?: string; boundingBox?: number[] };
type DetectionEvent = { detections?: Detection[]; detectionId?: string; timestamp?: number; durationMs?: number; processingMs?: number };
// health/drops1h describe the camera device's own Online state (Scrypted's aggregate online
// flag, tracked in real time -- see setupOnlineListeners/handleOnlineChange below), NOT the
// health of any individual RTSP/rebroadcast stream under it. A stream (e.g. the NVR recording
// stream) can be restarting repeatedly while Online stays true, because another stream on the
// same camera (e.g. the low-res analysis stream) still has data -- that is not visible here.
type CameraInfo = { id: string; name: string; nvrCardId: string | null; online: boolean; health: 'ok' | 'unstable' | 'offline'; drops1h: number; wildlife: boolean; lastDetection: { species: string; at: number; visitId: string; kind: VisitKind; grp: VisitGroup } | null };
type CameraRuntime = { lastDetectionAt: number | null; lastErrorAt: number | null; wasOnline?: boolean; drops: number[]; durationTotal: number; durationSamples: number };
type PendingDetection = { key: string; cameraId: string; detectionId?: string; startedAt: number; score: number | null; label?: string; detectionLabel?: string; box?: number[]; capture: Promise<{ snapshot: Buffer; crop: Buffer }>; timer?: NodeJS.Timeout };
type DetectorSession = { sawObject: boolean; timer: NodeJS.Timeout };
type DeviceWithSettings = { name?: string; interfaces?: string[]; mixins?: string[]; getSettings?: () => Promise<Setting[]> };
type BrokerMessage = Record<string, unknown>;

function parseIds(value: unknown): string[] {
    if (Array.isArray(value)) return value.map(String).filter(Boolean);
    if (typeof value !== 'string' || !value) return [];
    try {
        const parsed: unknown = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : value.split(',').map(item => item.trim()).filter(Boolean);
    } catch {
        return value.split(',').map(item => item.trim()).filter(Boolean);
    }
}

function slugify(value: string): string {
    return value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'camera';
}

function asNumber(value: unknown): number | undefined {
    const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
    return Number.isFinite(number) ? number : undefined;
}
function systemDeviceValue<T>(id: string, property: string): T | undefined {
    return sdk.systemManager.getSystemState()[id]?.[property]?.value as T | undefined;
}

// BirdNET-Go publishes Date ("2024-01-15") and Time ("14:30:00") as separate local-wall-clock
// strings plus an optional IANA `timezone`, not a single combined timestamp. This install's
// BirdNET-Go and Home Assistant both run on America/New_York, so that is the fallback when
// `timezone` is absent from a message.
const DEFAULT_BIRDNET_TIME_ZONE = 'America/New_York';

function zonedDateTimeToUtcMillis(dateStr: string, timeStr: string, timeZone: string): number | undefined {
    const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
    const timeMatch = /^(\d{2}):(\d{2}):(\d{2})/.exec(timeStr);
    if (!dateMatch || !timeMatch) return undefined;
    const [, year, month, day] = dateMatch;
    const [, hour, minute, second] = timeMatch;
    // Guess the UTC instant is the wall-clock numbers taken literally, then see how that
    // guess renders back in `timeZone`; the gap is the zone's offset at that instant
    // (DST-aware), so subtracting it corrects the guess to the true UTC instant.
    const guess = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
    let formatter: Intl.DateTimeFormat;
    try {
        formatter = new Intl.DateTimeFormat('en-US', {
            timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
        });
    } catch {
        return guess; // Unrecognized IANA zone name: treat the wall-clock numbers as UTC rather than fail outright.
    }
    const parts = Object.fromEntries(formatter.formatToParts(guess).map(part => [part.type, part.value]));
    const renderedAsUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    return guess - (renderedAsUtc - guess);
}

function parseBirdnetTimestamp(message: BrokerMessage): number | undefined {
    const dateValue = message.Date ?? message.date;
    const timeValue = message.Time ?? message.time;
    if (typeof dateValue === 'string' && typeof timeValue === 'string') {
        const zoneValue = message.timezone;
        const zone = typeof zoneValue === 'string' && zoneValue.trim() ? zoneValue.trim() : DEFAULT_BIRDNET_TIME_ZONE;
        const zoned = zonedDateTimeToUtcMillis(dateValue, timeValue, zone);
        if (zoned !== undefined) return zoned;
    }
    // Fallback for a payload shaped with a single combined timestamp field instead.
    const rawTime = message.timestamp ?? message.Timestamp ?? message.dateTime ?? message.DateTime;
    const parsedTime = typeof rawTime === 'string' ? Date.parse(rawTime) : asNumber(rawTime);
    return parsedTime !== undefined && Number.isFinite(parsedTime) ? normalizedTime(parsedTime) : undefined;
}

function normalizedTime(value: number): number {
    return value > 0 && value < 100_000_000_000 ? value * 1000 : value;
}

function groupForSpecies(species: string, kind: VisitKind): VisitGroup {
    const name = species.toLowerCase();
    if (kind === 'seen') {
        const known = SPECIES_GROUPS[name];
        if (known) return known;
    }
    // Fallback keyword heuristic: for 'seen', labels the local classifier's 268-species list
    // doesn't cover (a hand-typed correction, or "Unidentified animal"). For 'heard', a common-
    // name correction on an audio visit -- the precise scientific-name/taxonomy resolution
    // (resolveHeardGroup, used at ingest) isn't available here, only the name Nitin typed.
    const mammals = ['squirrel', 'raccoon', 'opossum', 'fox', 'coyote', 'deer', 'rabbit', 'cat', 'dog', 'mouse', 'rat', 'chipmunk', 'groundhog', 'skunk', 'bear', 'mole', 'shrew', 'bat', 'porcupine', 'beaver', 'bobcat', 'armadillo', 'weasel', 'mink', 'otter', 'muskrat', 'vole', 'marmot'];
    const birds = ['bird', 'crow', 'raven', 'hawk', 'owl', 'eagle', 'finch', 'sparrow', 'cardinal', 'dove', 'pigeon', 'warbler', 'woodpecker', 'jay', 'wren', 'thrush', 'blackbird', 'heron', 'duck', 'goose', 'chicken', 'robin', 'starling', 'swallow', 'gull', 'kingfisher', 'oriole', 'tanagers', 'turkey', 'hummingbird', 'bluebird'];
    if (mammals.some(label => name.includes(label))) return 'mammal';
    if (birds.some(label => name.includes(label))) return 'bird';
    return kind === 'heard' ? 'bird' : 'unknown';
}

// Resolves grp for a heard (audio) detection from BirdNET-Go's ScientificName: exact species
// match -> genus match -> default 'bird' (Perch's output is overwhelmingly birds). Returns
// 'drop' for Insecta -- BirdNET-Go's insect calls are too unreliable to keep as a visit.
function resolveHeardGroup(scientificName: string | undefined): VisitGroup | 'drop' {
    const normalized = scientificName?.toLowerCase().trim();
    if (!normalized) return 'bird';
    const cls = SPECIES_CLASS.get(normalized) ?? GENUS_CLASS.get(normalized.split(' ')[0]);
    switch (cls) {
        case 'Mammalia': return 'mammal';
        case 'Amphibia':
        case 'Reptilia': return 'other';
        case 'Insecta': return 'drop';
        default: return 'bird';
    }
}

// One-time-migration-only: the specific non-bird common names already verified (2026-09-28,
// via classifier/data/inat21_categories.json) to exist in stored heard visits from before this
// fix, keyed lowercased. Existing rows only have the common name persisted, not BirdNET-Go's
// ScientificName, so this can't reuse resolveHeardGroup's precise taxonomy lookup -- it is
// intentionally small and exact rather than a second bundled reference table. Species not
// listed here default to 'bird' (unchanged), same as resolveHeardGroup's own default.
const KNOWN_NON_BIRD_HEARD_SPECIES: Readonly<Record<string, VisitGroup | 'drop'>> = {
    'coyote': 'mammal',
    'eastern chipmunk': 'mammal',
    'eastern gray squirrel': 'mammal',
    'spring peeper': 'other',
    'japanese burrowing cricket': 'drop',
};

// One-time repair (found 2026-10-01 04:45 EDT): a single raccoon on the Front Door porch was filed
// as two visits 0.75 s apart -- "Common Raccoon" 0.84 (no clip: the Events Recorder clip began after
// its start) and "Southern Flying Squirrel" 0.82 (the READY clip). The squirrel visit is folded into
// the raccoon one; see seen.ts for the cause and the grouping that now prevents it.
const SPLIT_RACCOON_KEEP_ID = '43030c7c-38d3-47fc-9dc8-0374bb5cc7fc';
const SPLIT_RACCOON_DROP_ID = '7c6dc9b9-b580-46d0-8d09-8403cebc7534';

function headerValue(headers: HttpRequest['headers'], name: string): string | undefined {
    if (!headers) return undefined;
    const target = name.toLowerCase();
    for (const [key, value] of Object.entries(headers))
        if (key.toLowerCase() === target) return value;
    return undefined;
}

function parseJsonBody(body?: string): Record<string, unknown> {
    if (!body) return {};
    const value: unknown = JSON.parse(body);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Request body must be a JSON object');
    return value as Record<string, unknown>;
}

function jsonReply(response: HttpResponse, code: number, body: unknown, headers: Record<string, string> = {}): void {
    response.send(JSON.stringify(body), { code, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });
}

async function* readStream(path: string, start: number, end: number): AsyncGenerator<Buffer, void> {
    const stream = createReadStream(path, { start, end });
    for await (const chunk of stream)
        yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}

class Kestrel extends ScryptedDeviceBase implements Settings, HttpRequestHandler {
    private store?: KestrelStore;
    private ready: Promise<void>;
    private baseDir = '';
    private mediaDirs?: { root: string; snapshots: string; crops: string; audio: string };
    private databasePath = '';
    private client?: MqttClient;
    private cameraListeners = new Map<string, { removeListener(): void }>();
    private cameras = new Map<string, { id: string; name: string; nvrCardId: string | null }>();
    private pending = new Map<string, PendingDetection>();
    private detectorSessions = new Map<string, DetectorSession>();
    // Which seen visit an animal is currently "inside", per camera (one entry each), so labels that
    // flip during a stay fold into that visit; and a per-camera queue so two detections of the same
    // animal commit one after the other instead of both creating a visit.
    private sameMoment = new SameMomentTracker();
    private cameraQueue = new KeyedQueue();
    // The camera list as it was when it was last published: the 30 s refresh only publishes a `camera`
    // event when the list now differs (online, health, drops, latest sighting, names).
    private cameraGate = new ChangeGate();
    private onlineListeners = new Map<string, { removeListener(): void }>();
    private cameraRuntime = new Map<string, CameraRuntime>();
    private eventWaiters = new Set<() => void>();
    private clipTimer?: NodeJS.Timeout;
    private healthTimer?: NodeJS.Timeout;
    private maintenanceTimer?: NodeJS.Timeout;
    private brokerGeneration = 0;
    private released = false;

    constructor() {
        super();
        this.ready = this.initialize();
        void this.ready.catch(error => this.console.error(`Kestrel initialization failed: ${String(error)}`));
    }

    private async initialize(): Promise<void> {
        const pluginFiles = await sdk.mediaManager.getFilesPath();
        this.baseDir = join(pluginFiles, 'kestrel');
        this.databasePath = join(this.baseDir, 'kestrel.sqlite');
        await mkdir(this.baseDir, { recursive: true });
        this.mediaDirs = await ensureMediaDirectories(this.baseDir);
        this.store = new KestrelStore(this.databasePath);
        this.store.onVisitsDeleted = ids => this.announceDeletedVisits(ids);
        if (!this.store.getSetting('apiKey')) this.store.setSetting('apiKey', randomBytes(32).toString('hex'));
        if (!this.store.getSetting(CAMERA_SETTING)) this.store.setSetting(CAMERA_SETTING, JSON.stringify(DEFAULT_CAMERAS));
        if (!this.store.getSetting('cooldownMinutes')) this.store.setSetting('cooldownMinutes', String(DEFAULT_COOLDOWN_MINUTES));
        if (!this.store.getSetting('brokerUrl')) this.store.setSetting('brokerUrl', DEFAULT_BROKER);
        if (!this.store.getSetting('birdnetTopic')) this.store.setSetting('birdnetTopic', DEFAULT_TOPIC);
        if (!this.store.getSetting('detectorSessionCountingV2Since')) {
            this.store.resetTodayDetectorCounts();
            this.store.setSetting('detectorSessionCountingV2Since', String(Date.now()));
        }
        if (!this.store.getSetting('heardDuplicatesCleanedAtV2')) {
            const { removed } = this.store.cleanupDuplicateHeardVisits();
            this.console.log(`Removed ${removed} duplicate heard visit(s) from the overlapping-subscription bug.`);
            this.store.setSetting('heardDuplicatesCleanedAtV2', String(Date.now()));
        }
        if (!this.store.getSetting('heardRegroupedAtV1')) {
            const { regrouped, dropped } = this.store.regroupHeardVisits(KNOWN_NON_BIRD_HEARD_SPECIES);
            this.console.log(`Regrouped ${regrouped} and dropped ${dropped} heard visit(s) using taxonomic classes instead of always 'bird'.`);
            this.store.setSetting('heardRegroupedAtV1', String(Date.now()));
        }
        if (!this.store.getSetting('splitSeenVisitRepairedAtV1')) {
            const outcome = await this.store.repairSplitSeenVisit(SPLIT_RACCOON_KEEP_ID, SPLIT_RACCOON_DROP_ID);
            this.console.log(`Split raccoon visit repair: ${outcome}.`);
            if (outcome === 'merged') {
                const kept = this.store.getVisit(SPLIT_RACCOON_KEEP_ID);
                if (kept) this.publishEvent('visit_updated', kept);
            }
            this.store.setSetting('splitSeenVisitRepairedAtV1', String(Date.now()));
        } else if (!this.store.getSetting('splitSeenVisitRemovalAnnouncedAtV1')) {
            // That repair ran before visit_deleted existed, so the removal of the squirrel visit was never
            // announced. Tell any dashboard that is still holding it, once.
            if (!this.store.getVisit(SPLIT_RACCOON_DROP_ID)) this.announceDeletedVisits([SPLIT_RACCOON_DROP_ID]);
            this.store.setSetting('splitSeenVisitRemovalAnnouncedAtV1', String(Date.now()));
        }
        await this.copyBrokerCredentials();
        await this.reconfigure();
        this.setupOnlineListeners();
        this.connectBirdnet();
        this.startTimers();
        await this.refreshCameraStatus();
    }

    private get db(): KestrelStore {
        if (!this.store) throw new Error('Kestrel storage has not initialized');
        return this.store;
    }

    async getSettings(): Promise<Setting[]> {
        await this.ready;
        const stored = this.db;
        return SETTINGS.map(setting => {
            const key = setting.key || '';
            let value: SettingValue = stored.getSetting(key, String(setting.value ?? ''));
            if (key === CAMERA_SETTING) value = parseIds(stored.getSetting(key, JSON.stringify(DEFAULT_CAMERAS)));
            return { ...setting, value };
        });
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        await this.ready;
        if (key === 'apiKey' || !SETTINGS.some(setting => setting.key === key)) return;
        const storedValue = key === CAMERA_SETTING ? JSON.stringify(parseIds(value)) : String(value ?? '');
        this.db.setSetting(key, storedValue);
        if (key === CAMERA_SETTING) await this.reconfigure();
        if (key === 'brokerUrl' || key === 'username' || key === 'password' || key === 'birdnetTopic') this.connectBirdnet();
    }

    private async copyBrokerCredentials(): Promise<void> {
        const missingUsername = !this.db.getSetting('username');
        const missingPassword = !this.db.getSetting('password');
        if (!missingUsername && !missingPassword) return;
        try {
            const device = sdk.systemManager.getDeviceById('202') as unknown as DeviceWithSettings;
            const settings = await device.getSettings?.();
            if (!settings) return;
            const username = settings.find(setting => setting.key === 'username')?.value;
            const password = settings.find(setting => setting.key === 'password')?.value;
            if (missingUsername && username) this.db.setSetting('username', String(username));
            if (missingPassword && password) this.db.setSetting('password', String(password));
        } catch {
            this.console.warn('Could not copy MQTT credentials from Scrypted device 202.');
        }
    }

    private async reconfigure(): Promise<void> {
        for (const listener of this.cameraListeners.values()) listener.removeListener();
        this.cameraListeners.clear();
        const selected = parseIds(this.db.getSetting(CAMERA_SETTING, JSON.stringify(DEFAULT_CAMERAS)));
        const cameras = new Map<string, { id: string; name: string; nvrCardId: string | null }>();
        for (const id of selected) {
            try {
                const device = sdk.systemManager.getDeviceById(id) as unknown as DeviceWithSettings;
                if (!device || !device.interfaces?.includes(ScryptedInterface.VideoCamera)) continue;
                const nvrCardId = device.mixins?.includes('130') ? id : null;
                cameras.set(id, { id, name: device.name || `Camera ${id}`, nvrCardId });
                if (!this.cameraRuntime.has(id)) this.cameraRuntime.set(id, { lastDetectionAt: null, lastErrorAt: null, drops: [], durationTotal: 0, durationSamples: 0 });
                const listener = sdk.systemManager.listenDevice(id, ScryptedInterface.ObjectDetector, (_source, _details, data) => {
                    void this.onDetection(id, data as DetectionEvent).catch(error => {
                        const runtime = this.runtime(id);
                        runtime.lastErrorAt = Date.now();
                        this.console.warn(`Detection handling failed for camera ${id}: ${String(error)}`);
                    });
                });
                this.cameraListeners.set(id, listener);
            } catch (error) {
                this.console.warn(`Unable to watch Scrypted camera ${id}: ${String(error)}`);
            }
        }
        this.cameras = cameras;
        await this.refreshCameraStatus();
    }

    private allVideoCameras(): Map<string, { id: string; name: string; nvrCardId: string | null }> {
        const state = sdk.systemManager.getSystemState();
        const cameras = new Map<string, { id: string; name: string; nvrCardId: string | null }>();
        for (const id of Object.keys(state)) {
            const interfaces = systemDeviceValue<string[]>(id, 'interfaces');
            if (!interfaces?.includes(ScryptedInterface.VideoCamera)) continue;
            const device = sdk.systemManager.getDeviceById(id) as unknown as DeviceWithSettings;
            if (!device) continue;
            const nvrCardId = device.mixins?.includes('130') ? id : null;
            cameras.set(id, { id, name: device.name || `Camera ${id}`, nvrCardId });
        }
        return cameras;
    }

    private setupOnlineListeners(): void {
        for (const listener of this.onlineListeners.values()) listener.removeListener();
        this.onlineListeners.clear();
        for (const id of this.allVideoCameras().keys()) {
            const runtime = this.runtime(id);
            runtime.wasOnline = systemDeviceValue<boolean>(id, 'online') !== false;
            const listener = sdk.systemManager.listenDevice(id, ScryptedInterface.Online, () => this.handleOnlineChange(id));
            this.onlineListeners.set(id, listener);
        }
    }

    private handleOnlineChange(cameraId: string): void {
        const online = systemDeviceValue<boolean>(cameraId, 'online') !== false;
        const runtime = this.runtime(cameraId);
        if (runtime.wasOnline === true && !online) runtime.drops.push(Date.now());
        runtime.wasOnline = online;
    }

    private cameraHealth(cameraId: string, online: boolean): 'ok' | 'unstable' | 'offline' {
        if (!online) return 'offline';
        return this.runtime(cameraId).drops.length >= 3 ? 'unstable' : 'ok';
    }

    private runtime(cameraId: string): CameraRuntime {
        let runtime = this.cameraRuntime.get(cameraId);
        if (!runtime) {
            runtime = { lastDetectionAt: null, lastErrorAt: null, drops: [], durationTotal: 0, durationSamples: 0 };
            this.cameraRuntime.set(cameraId, runtime);
        }
        const hourAgo = Date.now() - 60 * 60 * 1000;
        runtime.drops = runtime.drops.filter(at => at >= hourAgo);
        return runtime;
    }

    private async onDetection(cameraId: string, event: DetectionEvent): Promise<void> {
        const camera = this.cameras.get(cameraId);
        if (!camera || !event || !Array.isArray(event.detections)) return;
        const runtime = this.runtime(cameraId);
        const startedAt = normalizedTime(asNumber(event.timestamp) ?? Date.now());
        const sawObject = event.detections.some(detection => !!detection.className && detection.className !== 'motion');
        this.recordDetectorSession(cameraId, event.detections.length > 0, sawObject);
        const duration = asNumber(event.processingMs ?? event.durationMs);
        if (duration !== undefined && duration >= 0) {
            runtime.durationTotal += duration;
            runtime.durationSamples++;
        }
        const animals = event.detections.filter(detection => detection.className === 'animal');
        if (!animals.length) return;
        runtime.lastDetectionAt = startedAt;
        // Any animal detection near an open visit keeps that visit "current" -- including unlabelled
        // ones -- so a label that flips mid-stay joins it rather than starting a second visit.
        this.sameMoment.touch(cameraId, startedAt, this.cooldownMs());
        for (const detection of animals) {
            const detectionId = detection.id || event.detectionId;
            const pendingForCamera = [...this.pending.values()].filter(candidate => candidate.cameraId === cameraId);
            const pending = pendingForCamera.find(candidate => !!detectionId && candidate.detectionId === detectionId)
                ?? (pendingForCamera.length === 1 && !detectionId ? pendingForCamera[0] : undefined);
            if (detection.label) {
                if (pending) {
                    clearTimeout(pending.timer);
                    this.pending.delete(pending.key);
                    pending.score = detection.score ?? pending.score;
                    await this.finishDetection(pending, detection.label, detection.label);
                } else {
                    const capture = captureDetection(cameraId, event.detectionId || detectionId, detection.boundingBox);
                    const record: PendingDetection = {
                        key: cameraId + ':' + (detectionId || randomUUID()), cameraId, detectionId, startedAt,
                        score: detection.score ?? null, label: detection.label, detectionLabel: detection.label, box: detection.boundingBox,
                        capture, timer: undefined,
                    };
                    await this.finishDetection(record, detection.label, detection.label);
                }
            } else if (!pending && pendingForCamera.length < 5) {
                const key = cameraId + ':' + (detectionId || 'unidentified');
                const capture = captureDetection(cameraId, event.detectionId || detectionId, detection.boundingBox);
                void capture.catch(() => { this.runtime(cameraId).lastErrorAt = Date.now(); });
                const remainingGrace = Math.max(0, startedAt + UNIDENTIFIED_GRACE_MS - Date.now());
                const record: PendingDetection = {
                    key, cameraId, detectionId, startedAt, score: detection.score ?? null,
                    detectionLabel: undefined, box: detection.boundingBox, capture,
                    timer: setTimeout(() => { void this.expirePending(key); }, remainingGrace),
                };
                this.pending.set(key, record);
            }
        }
    }

    private recordDetectorSession(cameraId: string, hasDetections: boolean, sawObject: boolean): void {
        const existing = this.detectorSessions.get(cameraId);
        if (existing) {
            if (sawObject) existing.sawObject = true;
            if (hasDetections) {
                clearTimeout(existing.timer);
                existing.timer = setTimeout(() => this.finishDetectorSession(cameraId), DETECTOR_SESSION_IDLE_MS);
            }
            return;
        }
        if (!hasDetections) return;
        this.detectorSessions.set(cameraId, {
            sawObject,
            timer: setTimeout(() => this.finishDetectorSession(cameraId), DETECTOR_SESSION_IDLE_MS),
        });
    }

    private finishDetectorSession(cameraId: string): void {
        const session = this.detectorSessions.get(cameraId);
        if (!session) return;
        this.detectorSessions.delete(cameraId);
        this.db.recordDetectorCheck(cameraId, !session.sawObject);
    }

    private async expirePending(key: string): Promise<void> {
        const pending = this.pending.get(key);
        if (!pending) return;
        this.pending.delete(key);
        try {
            await this.finishDetection(pending, 'Unidentified animal', 'Unidentified animal');
        } catch (error) {
            this.console.warn(`Could not finish unidentified visit on camera ${pending.cameraId}: ${String(error)}`);
        }
    }

    private async finishDetection(pending: PendingDetection, species: string, detectionLabel: string): Promise<Visit | undefined> {
        const capture = await pending.capture;
        let finalSpecies = species;
        let visitStatus: 'auto' | 'learned' = 'auto';
        try {
            const queryBuffer = await embedCrop(capture.crop);
            const query = queryBuffer && embeddingFromBuffer(queryBuffer);
            if (query) {
                const examples: LearningExample[] = [];
                for (const candidate of this.db.learningExamples(pending.cameraId, detectionLabel)) {
                    const embedding = embeddingFromBuffer(candidate.embedding);
                    if (embedding) examples.push({ ...candidate, embedding });
                }
                const learned = chooseLearnedLabel(pending.cameraId, detectionLabel, query, examples);
                if (learned) { finalSpecies = learned; visitStatus = 'learned'; }
            }
        } catch (error) {
            this.console.warn(`CLIP learning lookup failed for camera ${pending.cameraId}: ${String(error)}`);
        }
        // One detection commits at a time per camera, so two reports of the same animal a moment apart
        // see each other's visit instead of both creating one.
        return this.cameraQueue.run(pending.cameraId, () => this.commitDetection(pending, capture, finalSpecies, visitStatus, detectionLabel));
    }

    private async commitDetection(pending: PendingDetection, capture: { snapshot: Buffer; crop: Buffer }, finalSpecies: string, visitStatus: 'auto' | 'learned', detectionLabel: string): Promise<Visit | undefined> {
        // The same animal at the same moment is one visit whatever each detection is labelled; only
        // after that does the per-species cooldown (earlier SEEN visits only) choose skip or create.
        const decision = decideSeenCommit(this.db, this.sameMoment, this.cooldownMs(),
            { cameraId: pending.cameraId, startedAt: pending.startedAt, species: finalSpecies });
        if (decision.action === 'merge') return this.mergeDetection(decision.target, pending, capture, finalSpecies, visitStatus, detectionLabel);
        if (decision.action === 'skip') return undefined;
        if (!this.mediaDirs) throw new Error('Media storage has not initialized');
        const id = randomUUID();
        const { snapshotFile, cropFile } = await saveCapture(this.mediaDirs, id, capture);
        const camera = this.cameras.get(pending.cameraId);
        if (!camera) return undefined;
        const firstEver = !this.db.hasSpecies(finalSpecies);
        const grp = groupForSpecies(finalSpecies, 'seen');
        const visit: Visit = {
            id, camera: { id: camera.id, name: camera.name }, kind: 'seen', startedAt: pending.startedAt, species: finalSpecies, grp,
            status: visitStatus, score: pending.score, snapshot: `media/snap/${id}.jpg`, crop: `media/crop/${id}.jpg`,
            clip: { state: 'pending', expectedReadyAt: pending.startedAt + CLIP_EXPECTED_DELAY_MS }, heard: null, audio: null,
            suggestions: this.suggestionsFor(camera.id, finalSpecies, detectionLabel), firstEver, muted: this.mutedSpecies().includes(finalSpecies), notify: false,
        };
        visit.notify = !visit.muted;
        this.db.saveVisit(visit, { detectionLabel, snapshotFile, cropFile });
        this.db.considerSpeciesBest(visit, snapshotFile, cropFile);
        this.sameMoment.remember(camera.id, id, pending.startedAt);
        await this.linkRelatedVisit(visit);
        const saved = this.db.getVisit(id) ?? visit;
        this.publishEvent('visit_new', saved);
        return saved;
    }

    // Folds a detection into the visit that already covers its moment: the higher-scoring label
    // keeps the species (ties: the earlier detection), the other label becomes a 'model'
    // suggestion, and a better score also supplies the photo. The visit keeps its one clip, one
    // visit_new, and only publishes visit_updated when the merge changed something.
    private async mergeDetection(target: Visit, pending: PendingDetection, capture: { snapshot: Buffer; crop: Buffer }, finalSpecies: string, visitStatus: 'auto' | 'learned', detectionLabel: string): Promise<Visit> {
        const merged = mergeSeenDetection({
            store: this.db,
            tracker: this.sameMoment,
            groupFor: species => groupForSpecies(species, 'seen'),
            usualSuggestions: (cameraId, species) => this.usualSuggestions(cameraId, species),
            isMuted: species => this.mutedSpecies().includes(species),
        }, target, { species: finalSpecies, score: pending.score, startedAt: pending.startedAt, status: visitStatus, detectionLabel });
        if (!merged.changed) return merged.visit;
        // The database change is complete before the photo is rewritten; the photo's file name is
        // the visit's id, so the stored paths do not change.
        if (merged.plan.replaceMedia && this.mediaDirs) {
            try {
                await saveCapture(this.mediaDirs, target.id, capture);
            } catch (error) {
                this.console.warn(`Could not replace the photo of visit ${target.id} after merging a better detection: ${String(error)}`);
            }
        }
        if (merged.plan.speciesChanged) await this.linkRelatedVisit(merged.visit);
        const saved = this.db.getVisit(target.id) ?? merged.visit;
        this.publishEvent('visit_updated', saved);
        return saved;
    }

    private cooldownMs(): number {
        return Math.max(0, Number(this.db.getSetting('cooldownMinutes', String(DEFAULT_COOLDOWN_MINUTES)))) * 60_000;
    }

    private async linkRelatedVisit(visit: Visit): Promise<void> {
        linkSeenAndHeard(this.db, visit, other => this.publishEvent('visit_updated', other));
    }

    private suggestionsFor(cameraId: string, species: string, modelLabel: string): Visit['suggestions'] {
        const suggestions: Visit['suggestions'] = [];
        if (modelLabel && modelLabel !== species && modelLabel !== 'Unidentified animal')
            suggestions.push({ species: modelLabel, why: 'model' });
        for (const item of this.usualSuggestions(cameraId, species))
            if (!suggestions.some(existing => existing.species === item.species)) suggestions.push(item);
        return suggestions;
    }

    // Species most often recorded (seen or heard) at this camera in the last 30 days, excluding
    // this species itself and anything that isn't a confirmed/auto animal ID. Shared by seen
    // visits (via suggestionsFor above) and heard visits (onBirdnetMessage) so both get the same
    // "usual suspects" list; computed once at ingest, not on every GET.
    private usualSuggestions(cameraId: string, species: string): Visit['suggestions'] {
        const since = Date.now() - USUAL_SUGGESTIONS_WINDOW_MS;
        return this.db.usualSpeciesAtCamera(cameraId, species, since, USUAL_SUGGESTIONS_LIMIT)
            .map(name => ({ species: name, why: 'usual' as const }));
    }


    private mutedSpecies(): string[] {
        return this.db.getJsonSetting<string[]>('mutedSpecies', []);
    }

    private async labels(): Promise<string[]> {
        try {
            const classifier = sdk.systemManager.getDeviceById('248') as unknown as DeviceWithSettings;
            const settings = await classifier.getSettings?.();
            const labelSetting = settings?.find(setting => setting.key === 'excludeClasses');
            return (labelSetting?.choices ?? []).map(String);
        } catch (error) {
            this.console.warn(`Unable to read Wildlife Classifier labels from device 248: ${String(error)}`);
            return [];
        }
    }

    private async cameraList(): Promise<CameraInfo[]> {
        const items: CameraInfo[] = [];
        for (const camera of this.allVideoCameras().values()) {
            const online = systemDeviceValue<boolean>(camera.id, 'online') !== false;
            const runtime = this.runtime(camera.id);
            const latest = this.db.listVisits({ camera: camera.id, limit: 1 }).items[0];
            items.push({ id: camera.id, name: camera.name, nvrCardId: camera.nvrCardId, online, health: this.cameraHealth(camera.id, online),
                drops1h: runtime.drops.length, wildlife: this.cameras.has(camera.id),
                lastDetection: latest ? { species: latest.species, at: latest.startedAt, visitId: latest.id, kind: latest.kind, grp: latest.grp } : null });
        }
        return items;
    }

    // Re-reads every camera's state (a camera going offline, a dropped connection) and tells listeners
    // only if the camera list now differs from the one they were last sent. Home Assistant and the
    // dashboards re-read the list on every `camera` event, so a heartbeat with nothing new only costs them work.
    private async refreshCameraStatus(): Promise<void> {
        for (const camera of this.allVideoCameras().values()) this.handleOnlineChange(camera.id);
        const cameras = await this.cameraList();
        if (this.cameraGate.changed(cameras)) this.publishEvent('camera', cameras);
    }

    private connectBirdnet(): void {
        const generation = ++this.brokerGeneration;
        if (this.client) {
            this.client.removeAllListeners();
            this.client.end(true);
            this.client = undefined;
        }
        const url = this.db.getSetting('brokerUrl', DEFAULT_BROKER).trim();
        if (!url) return;
        const client = mqtt.connect(url, {
            username: this.db.getSetting('username') || undefined,
            password: this.db.getSetting('password') || undefined,
            reconnectPeriod: 3_000,
            connectTimeout: 10_000,
        });
        this.client = client;
        client.on('connect', () => {
            if (generation !== this.brokerGeneration) return;
            const topic = this.db.getSetting('birdnetTopic', DEFAULT_TOPIC).trim() || DEFAULT_TOPIC;
            // `topic/#` already matches the exact base topic too (MQTT wildcard semantics), so a
            // separate `topic` subscription alongside it is a second, overlapping match --
            // the broker then delivers every message twice. Subscribe to the wildcard only.
            client.subscribe(`${topic.replace(/\/+$/, '')}/#`, { qos: 1 }, error => {
                if (error) this.console.warn(`BirdNET MQTT subscribe failed: ${error.message}`);
            });
        });
        client.on('message', (topic, payload) => {
            if (generation !== this.brokerGeneration) return;
            void this.onBirdnetMessage(topic, payload).catch(error => this.console.warn(`BirdNET message could not be processed: ${String(error)}`));
        });
        client.on('error', error => this.console.warn(`BirdNET MQTT connection error: ${error.message}`));
    }

    private async onBirdnetMessage(_topic: string, payload: Buffer): Promise<void> {
        if (payload.length > 1_000_000) return;
        let message: BrokerMessage;
        try {
            const parsed: unknown = JSON.parse(payload.toString('utf8'));
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
            message = parsed as BrokerMessage;
        } catch {
            return;
        }
        // Real shape is BirdNET-Go's MQTTEventDTO (internal/mqtt/dto.go): flat, mostly
        // PascalCase, Date+Time as separate local-wall-clock strings. The lowercase/camelCase
        // fallbacks below are tolerance for a differently-shaped publisher on the same topic,
        // not anything BirdNET-Go itself sends.
        const speciesValue = message.CommonName ?? message.commonName ?? message.species ?? message.Species;
        if (typeof speciesValue !== 'string' || !speciesValue.trim()) return;
        const startedAt = parseBirdnetTimestamp(message) ?? Date.now();
        // A real, parseable BirdNET-Go detection was received on the topic -- mark it heard even if the
        // source doesn't map to a watched camera below, so health.birdnet reflects real broker traffic.
        this.db.setSetting('birdnetLastHeardAt', String(startedAt));
        const sourceValue = message.sourceName ?? message.SourceName ?? message.source ?? message.Source ?? message.camera ?? message.Camera;
        const cameraId = this.cameraForBirdnetSource(String(sourceValue ?? ''));
        if (!cameraId) return;
        const camera = this.cameras.get(cameraId);
        if (!camera) return;
        const confidence = asNumber(message.Confidence ?? message.confidence ?? message.score ?? message.Score);
        const score = confidence === undefined ? null : confidence > 1 ? confidence / 100 : confidence;
        const species = speciesValue.trim();
        const scientificValue = message.ScientificName ?? message.scientificName ?? message.scientific_name;
        const grp = resolveHeardGroup(typeof scientificValue === 'string' ? scientificValue : undefined);
        // Perch (BirdNET-Go's multi-taxa audio model) also emits insect calls, which are too
        // unreliable to keep as a visit -- drop silently (no visit, no event, no notification),
        // but keep a visible daily count so an unexpected flood of these is noticeable in health.
        if (grp === 'drop') {
            this.db.recordBirdnetIgnored();
            return;
        }
        // Same cooldown as seen visits (10 min per camera+species by default): a bird that keeps
        // calling triggers BirdNET-Go repeatedly, so fold repeats into the one existing visit
        // instead of creating a new row per detection.
        const cooldown = Math.max(0, Number(this.db.getSetting('cooldownMinutes', String(DEFAULT_COOLDOWN_MINUTES)))) * 60_000;
        if (this.db.findRecentHeardVisit(cameraId, species, startedAt - cooldown)) return;
        const firstEver = !this.db.hasSpecies(species);
        const id = randomUUID();
        // BirdNET-Go's own reference to its detection and clip -- Kestrel never fetches or
        // stores the audio itself; the HA integration reaches BirdNET-Go directly for it.
        const birdnetDetectionId = asNumber(message.detectionId ?? message.DetectionID ?? message.detection_id) ?? null;
        const clipValue = message.ClipName ?? message.clipName ?? message.clip_name;
        const birdnetClip = typeof clipValue === 'string' && clipValue.trim() ? clipValue.trim() : null;
        const visit: Visit = {
            id, camera: { id: camera.id, name: camera.name }, kind: 'heard', startedAt, species, grp, status: 'auto', score,
            snapshot: null, crop: null, clip: { state: 'none', expectedReadyAt: null }, heard: null,
            audio: birdnetDetectionId !== null || birdnetClip !== null ? { birdnetDetectionId, birdnetClip } : null,
            suggestions: this.usualSuggestions(cameraId, species),
            firstEver, muted: this.mutedSpecies().includes(species), notify: false,
        };
        visit.notify = !visit.muted && this.db.getSetting('heardNotify', 'new_only') !== 'never' && firstEver;
        this.db.saveVisit(visit, { birdnetDetectionId, birdnetClip });
        await this.linkRelatedVisit(visit);
        this.publishEvent('visit_new', this.db.getVisit(id) ?? visit);
    }

    private cameraForBirdnetSource(source: string): string | undefined {
        const mapping = this.db.getJsonSetting<Record<string, string>>('birdnetCameraMap', {});
        const mapped = Object.entries(mapping).find(([name]) => name.toLowerCase() === source.toLowerCase())?.[1];
        if (mapped && this.cameras.has(String(mapped))) return String(mapped);
        const normalized = slugify(source);
        return [...this.cameras.values()].find(camera => camera.id === source || camera.name.toLowerCase() === source.toLowerCase() || slugify(camera.name) === normalized)?.id;
    }

    private async findClip(cameraId: string, startedAt: number): Promise<string | undefined> {
        const camera = sdk.systemManager.getDeviceById(cameraId) as unknown as VideoClips;
        let clips: VideoClip[] = [];
        if (typeof camera.getVideoClips === 'function') {
            try {
                clips = await camera.getVideoClips({ startTime: startedAt - 90_000, endTime: startedAt + 90_000, count: 50 });
            } catch (error) {
                this.console.warn(`Events Recorder clip lookup failed for camera ${cameraId}: ${String(error)}`);
            }
        }
        const overlapping = clips.filter(clip => {
            const start = normalizedTime(clip.startTime);
            const duration = normalizedTime(clip.duration ?? 60_000);
            return clipCoversVisitStart(start, start + duration, startedAt);
        }).sort((a, b) => Math.abs(a.startTime - startedAt) - Math.abs(b.startTime - startedAt));
        for (const clip of overlapping) {
            const resource = clip.resources?.video?.file;
            if (resource && existsSync(resource)) return resource;
        }
        const directory = `/NVR/clips/${cameraId}/videoclips`;
        const files = await readdir(directory).catch(() => [] as string[]);
        let best: { path: string; gap: number } | undefined;
        for (const file of files) {
            const match = file.match(/^(\d+(?:\.\d+)?)_(\d+(?:\.\d+)?)(?:_[^/]*)?\.mp4$/i);
            if (!match) continue;
            const start = normalizedTime(Number(match[1]));
            const end = normalizedTime(Number(match[2]));
            if (clipCoversVisitStart(start, end, startedAt)) {
                const candidate = join(directory, file);
                const gap = Math.abs(start - startedAt);
                if (!best || gap < best.gap) best = { path: candidate, gap };
            }
        }
        if (best && existsSync(best.path)) return best.path;
        for (const clip of overlapping) {
            const file = clip.resources?.video?.file;
            if (file) {
                const candidate = file.startsWith('/') ? file : join('/NVR/clips', cameraId, 'videoclips', file);
                if (existsSync(candidate)) return candidate;
            }
        }
        return undefined;
    }

    private async pollClips(): Promise<void> {
        const now = Date.now();
        const pending = this.db.listPendingClips(now, 100);
        for (const row of pending) {
            const file = await this.findClip(row.camera_id, row.started_at);
            if (file) {
                this.db.setClip(row.id, 'ready', file);
                const visit = this.db.getVisit(row.id);
                if (visit) this.publishEvent('visit_updated', visit);
            } else if (now - row.started_at >= CLIP_GIVE_UP_MS) {
                this.db.setClip(row.id, 'none', null);
                const visit = this.db.getVisit(row.id);
                if (visit) this.publishEvent('visit_updated', visit);
            }
        }
        const ready = this.db.listVisits({ limit: 50 }).items.filter(visit => visit.clip.state === 'ready');
        for (const visit of ready) {
            const file = this.db.getRawVisit(visit.id)?.clip_file;
            if (file && !existsSync(file)) {
                this.db.setClip(visit.id, 'deleted', null);
                const updated = this.db.getVisit(visit.id);
                if (updated) this.publishEvent('visit_updated', updated);
            }
        }
    }

    private async correctVisit(id: string, species: string): Promise<Visit> {
        const current = this.db.getVisit(id);
        const raw = this.db.getRawVisit(id);
        if (!current || !raw) throw Object.assign(new Error('Visit not found'), { status: 404 });
        const target = species === 'not_animal' || species === 'unknown' ? species : species.trim();
        if (!target || target.length > 200) throw Object.assign(new Error('A valid species label is required'), { status: 400 });
        const status: VisitStatus = target === 'not_animal' ? 'not_animal' : target === 'unknown' ? 'unknown' : 'corrected';
        const from = raw.detection_label || current.species;
        const updated: Visit = { ...current, species: target, grp: groupForSpecies(target, current.kind), status, review: false };
        updated.muted = this.mutedSpecies().includes(target);
        updated.notify = updated.kind === 'seen' ? !updated.muted : !updated.muted && updated.firstEver && this.db.getSetting('heardNotify', 'new_only') !== 'never';
        const correctionId = this.db.recordCorrection(updated, from, target, false, raw.snapshot_file, raw.crop_file);
        this.db.saveVisit(updated, { lastChangeAt: Date.now(), undoData: JSON.stringify(current), lastCorrectionId: correctionId, detectionLabel: raw.detection_label, review: false });
        this.db.refreshSpeciesBestForVisit(id);
        if (raw.crop_file) {
            try {
                const embedding = await embedCrop(await readFile(raw.crop_file));
                if (embedding) this.db.addEmbedding(correctionId, current.camera.id, from, target, embedding);
            } catch (error) {
                this.console.warn(`CLIP embedding failed for correction ${id}: ${String(error)}`);
            }
        }
        this.db.considerSpeciesBest(updated, raw.snapshot_file, raw.crop_file);
        const result = this.db.getVisit(id) ?? updated;
        this.publishEvent('visit_updated', result);
        return result;
    }

    private async confirmVisit(id: string, alsoHeard: boolean): Promise<Visit> {
        const current = this.db.getVisit(id);
        const raw = this.db.getRawVisit(id);
        if (!current || !raw) throw Object.assign(new Error('Visit not found'), { status: 404 });
        const from = current.species;
        const updated: Visit = { ...current, status: 'confirmed', review: false };
        if (alsoHeard && updated.kind === 'seen') {
            const matches = this.db.findHeardOrSeen(updated.camera.id, updated.species, 'seen', updated.startedAt);
            const heard = matches.find(row => row.species === updated.species && row.kind === 'heard');
            if (heard) updated.heard = { visitId: heard.id, species: heard.species, hasAudio: heard.birdnet_detection_id != null,
                birdnetDetectionId: heard.birdnet_detection_id, birdnetClip: heard.birdnet_clip };
        }
        const correctionId = this.db.recordCorrection(updated, from, current.species, true, raw.snapshot_file, raw.crop_file);
        this.db.saveVisit(updated, { lastChangeAt: Date.now(), undoData: JSON.stringify(current), lastCorrectionId: correctionId, review: false });
        if (raw.crop_file) {
            try {
                const embedding = await embedCrop(await readFile(raw.crop_file));
                if (embedding) this.db.addEmbedding(correctionId, current.camera.id, from, current.species, embedding);
            } catch (error) {
                this.console.warn(`CLIP embedding failed for confirmation ${id}: ${String(error)}`);
            }
        }
        const result = this.db.getVisit(id) ?? updated;
        this.publishEvent('visit_updated', result);
        return result;
    }

    private undoVisit(id: string): Visit {
        const raw = this.db.getRawVisit(id);
        if (!raw) throw Object.assign(new Error('Visit not found'), { status: 404 });
        if (!raw.last_change_at || !raw.undo_data || !raw.last_correction_id || Date.now() - raw.last_change_at > 10_000)
            throw Object.assign(new Error('Undo window has expired'), { status: 409 });
        const current = this.db.getVisit(id);
        const previous = JSON.parse(raw.undo_data) as Visit;
        if (!current) throw Object.assign(new Error('Visit not found'), { status: 404 });
        const restored: Visit = { ...current, species: previous.species, grp: previous.grp, status: previous.status, muted: previous.muted, notify: previous.notify, review: previous.review, heard: previous.heard };
        this.db.deleteCorrection(raw.last_correction_id);
        this.db.saveVisit(restored, { lastChangeAt: null, undoData: null, lastCorrectionId: null, review: !!previous.review });
        this.db.refreshSpeciesBestForVisit(id);
        this.db.considerSpeciesBest(restored, raw.snapshot_file, raw.crop_file);
        const result = this.db.getVisit(id) ?? restored;
        this.publishEvent('visit_updated', result);
        return result;
    }

    private async settingsGet(): Promise<{ mutedSpecies: string[]; heardNotify: 'new_only' | 'never' }> {
        return { mutedSpecies: this.mutedSpecies(), heardNotify: this.db.getSetting('heardNotify', 'new_only') === 'never' ? 'never' : 'new_only' };
    }

    private async settingsPut(body: Record<string, unknown>): Promise<{ mutedSpecies: string[]; heardNotify: 'new_only' | 'never' }> {
        if (body.mutedSpecies !== undefined) {
            if (!Array.isArray(body.mutedSpecies) || body.mutedSpecies.some(item => typeof item !== 'string'))
                throw Object.assign(new Error('mutedSpecies must be a list of species names'), { status: 400 });
            this.db.setSetting('mutedSpecies', JSON.stringify([...new Set(body.mutedSpecies as string[])]));
        }
        if (body.heardNotify !== undefined) {
            if (body.heardNotify !== 'new_only' && body.heardNotify !== 'never')
                throw Object.assign(new Error('heardNotify must be new_only or never'), { status: 400 });
            this.db.setSetting('heardNotify', String(body.heardNotify));
        }
        return this.settingsGet();
    }

    private async health(): Promise<Record<string, unknown>> {
        const detector = sdk.systemManager.getDeviceById('248') as unknown as DeviceWithSettings;
        const detectorSettings = await detector.getSettings?.().catch(() => [] as Setting[]) ?? [];
        const provider = detectorSettings.find(setting => setting.key === 'provider' || setting.key === 'executionProvider')?.value;
        const lastHeardAt = Number(this.db.getSetting('birdnetLastHeardAt', '0')) || null;
        const stats = this.db.correctionStats();
        const now = Date.now();
        const counterItems = [...this.cameras.keys()].map(id => ({ id, ...this.db.cameraDailyStats(id, now) }));
        const gpu = this.gpuStats();
        const mediaMB = await this.directorySize(this.mediaDirs?.root ?? this.baseDir) / (1024 * 1024);
        const databaseFiles = await Promise.all([this.databasePath, `${this.databasePath}-wal`, `${this.databasePath}-shm`].map(file => stat(file).catch(() => undefined)));
        const dbMB = databaseFiles.reduce((total, file) => total + (file?.size ?? 0), 0) / (1024 * 1024);
        return {
            detector: { name: detector.name || 'Wildlife Classifier', provider: provider ? String(provider) : 'ONNX', avgMs: this.averageDetectorMs(), checksToday: counterItems.reduce((sum, item) => sum + item.checksToday, 0) },
            gpu,
            cameras: counterItems,
            storage: { dbMB: Number(dbMB.toFixed(2)), mediaMB: Number(mediaMB.toFixed(2)), budgetMB: 300 },
            birdnet: lastHeardAt === null ? null : { online: now - lastHeardAt <= 30 * 60_000, lastHeardAt, ignoredToday: this.db.birdnetIgnoredToday(now) },
            corrections: { total: stats.total, sinceRetrain: stats.sinceRetrain },
        };
    }

    private averageDetectorMs(): number | null {
        let total = 0;
        let samples = 0;
        for (const id of this.cameras.keys()) {
            const runtime = this.runtime(id);
            total += runtime.durationTotal;
            samples += runtime.durationSamples;
        }
        return samples ? Number((total / samples).toFixed(1)) : null;
    }

    private gpuStats(): { usedMiB: number | null; totalMiB: number | null; util: number | null } {
        try {
            const output = execFileSync('nvidia-smi', ['--query-gpu=memory.used,memory.total,utilization.gpu', '--format=csv,noheader,nounits'], { timeout: 2_000, encoding: 'utf8' }).trim().split(/\r?\n/)[0];
            const [used, total, util] = output.split(',').map(value => Number(value.trim()));
            if (![used, total, util].every(Number.isFinite)) return { usedMiB: null, totalMiB: null, util: null };
            return { usedMiB: used, totalMiB: total, util };
        } catch {
            return { usedMiB: null, totalMiB: null, util: null };
        }
    }

    private async directorySize(directory: string): Promise<number> {
        let total = 0;
        for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) total += await this.directorySize(path);
            else if (entry.isFile()) total += (await stat(path).catch(() => ({ size: 0 } as { size: number }))).size;
        }
        return total;
    }

    private publishEvent(type: EventItem['type'], data: unknown): void {
        this.db.appendEvent(type, data);
        for (const wake of this.eventWaiters) wake();
    }

    // A visit row was removed (split-visit repair, duplicate cleanup, regrouping, retention): tell the
    // open dashboards so they drop it. The store calls this in the middle of the removal, so it must not throw.
    private announceDeletedVisits(ids: string[]): void {
        try {
            for (const id of ids) this.publishEvent('visit_deleted', { id });
        } catch (error) {
            this.console.warn(`Could not announce ${ids.length} deleted visit(s): ${String(error)}`);
        }
    }

    // `timeoutMs` is how long to hold the request open when nothing is pending (callers pass
    // parseLongPollTimeoutMs, already clamped to 0..25 s). Pending events return immediately.
    private async waitForEvents(after: number, timeoutMs: number): Promise<EventsResponse> {
        let result = this.db.eventsAfter(after);
        if (result.resync || result.events?.length || timeoutMs <= 0) return result;
        if (this.eventWaiters.size >= MAX_LONG_POLLS) throw Object.assign(new Error('Too many waiting event requests'), { status: 503 });
        await new Promise<void>(resolve => {
            let complete = false;
            const finish = () => {
                if (complete) return;
                complete = true;
                clearTimeout(timer);
                this.eventWaiters.delete(wake);
                resolve();
            };
            const wake = () => finish();
            const timer = setTimeout(finish, timeoutMs);
            this.eventWaiters.add(wake);
        });
        // Woken by shutdown: the store is closed (or closing); answer empty and let the client retry.
        if (this.released) return { seq: after, events: [] };
        result = this.db.eventsAfter(after);
        return result;
    }

    private async speciesDetail(name: string): Promise<Record<string, unknown> | undefined> {
        const species = this.db.speciesList().find(item => (item as { species: string }).species === name);
        if (!species) return undefined;
        const visits = this.db.listVisits({ species: name, limit: 50 });
        return { ...species as object, visits: visits.items, next: visits.next };
    }

    private async correctionsExport(): Promise<Record<string, unknown>> {
        const exported = this.db.correctionExport();
        return { generatedAt: Date.now(), classifier: { deviceId: '248', labels: await this.labels() }, items: exported.items, sinceRetrain: exported.sinceRetrain };
    }

    private async serveMedia(kind: string, id: string, request: HttpRequest, response: HttpResponse): Promise<void> {
        const mediaId = kind === 'clip' ? id.replace(/\.mp4$/i, '')
            : kind === 'audio' ? id
            : id.replace(/\.jpg$/i, '');
        const row = this.db.getRawVisit(mediaId);
        let file: string | null | undefined;
        let contentType = 'application/octet-stream';
        if (kind === 'snap') { file = row?.snapshot_file; contentType = 'image/jpeg'; }
        else if (kind === 'crop') { file = row?.crop_file; contentType = 'image/jpeg'; }
        else if (kind === 'clip') { file = row?.clip_file; contentType = 'video/mp4'; }
        else if (kind === 'audio') { file = row?.audio_file; contentType = 'audio/mpeg'; }
        else if (kind === 'camera') { file = this.db.latestVisitForCamera(mediaId)?.snapshot_file; contentType = 'image/jpeg'; }
        else if (kind === 'species') {
            file = this.db.speciesBestPath(mediaId) || this.db.latestVisitForSpecies(mediaId)?.snapshot_file;
            contentType = 'image/jpeg';
        }
        if (!file || !existsSync(file)) {
            if (kind === 'clip' && row?.clip_state === 'ready') {
                this.db.setClip(mediaId, 'deleted', null);
                const visit = this.db.getVisit(mediaId);
                if (visit) this.publishEvent('visit_updated', visit);
            }
            jsonReply(response, 404, { error: 'Media not found' });
            return;
        }
        const info = await stat(file);
        const range = headerValue(request.headers, 'range');
        if (!range) {
            response.sendFile(file, { headers: { 'Content-Type': contentType, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store' } });
            return;
        }
        const match = range.match(/^bytes=(\d*)-(\d*)$/);
        if (!match) {
            jsonReply(response, 416, { error: 'Invalid byte range' }, { 'Content-Range': 'bytes */' + info.size });
            return;
        }
        let start: number;
        let end: number;
        if (!match[1]) {
            const suffix = Number(match[2]);
            if (!Number.isSafeInteger(suffix) || suffix <= 0) {
                jsonReply(response, 416, { error: 'Byte range is not satisfiable' }, { 'Content-Range': 'bytes */' + info.size });
                return;
            }
            start = Math.max(0, info.size - suffix);
            end = info.size - 1;
        } else {
            start = Number(match[1]);
            end = match[2] ? Math.min(info.size - 1, Number(match[2])) : info.size - 1;
        }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= info.size || end < start) {
            jsonReply(response, 416, { error: 'Byte range is not satisfiable' }, { 'Content-Range': 'bytes */' + info.size });
            return;
        }
        response.sendStream(readStream(file, start, end), { code: 206, headers: { 'Content-Type': contentType, 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1), 'Content-Range': 'bytes ' + start + '-' + end + '/' + info.size, 'Cache-Control': 'private, no-store' } });
    }

    private async handleApi(request: HttpRequest, response: HttpResponse): Promise<void> {
        const supplied = headerValue(request.headers, 'X-Kestrel-Key');
        const expected = this.db.getSetting('apiKey');
        const suppliedBuffer = Buffer.from(supplied ?? '', 'utf8');
        const expectedBuffer = Buffer.from(expected, 'utf8');
        if (!supplied || suppliedBuffer.length !== expectedBuffer.length || !timingSafeEqual(suppliedBuffer, expectedBuffer)) {
            jsonReply(response, 401, { error: 'Unauthorized' });
            return;
        }
        const rawUrl = request.url || '/';
        const url = new URL(rawUrl, 'http://scrypted.local');
        let pathname = url.pathname;
        const publicIndex = pathname.indexOf('/public/');
        if (publicIndex >= 0) pathname = pathname.slice(publicIndex + '/public/'.length);
        else pathname = pathname.replace(/^\/+/, '');
        pathname = pathname.replace(/\/+$/, '');
        const method = (request.method || 'GET').toUpperCase();
        const parts = pathname.split('/').filter(Boolean).map(part => decodeURIComponent(part));
        const route = parts.join('/');
        try {
            if (route.startsWith('media/')) {
                await this.serveMedia(parts[1], parts[2] || '', request, response);
                return;
            }
            if (method === 'GET' && route === 'cameras') { jsonReply(response, 200, { items: await this.cameraList() }); return; }
            if (method === 'GET' && route === 'visits') {
                const before = url.searchParams.get('before');
                const beforeNumber = before ? Date.parse(before) || Number(before) : undefined;
                jsonReply(response, 200, this.db.listVisits({ camera: url.searchParams.get('camera') || undefined, species: url.searchParams.get('species') || undefined,
                    kind: url.searchParams.get('kind') || undefined, status: url.searchParams.get('status') || undefined, before: beforeNumber,
                    limit: Number(url.searchParams.get('limit') || 50) })); return;
            }
            if (method === 'GET' && route === 'events') {
                const after = Math.max(0, Number(url.searchParams.get('after') || 0));
                // `timeout` is in SECONDS (0-25), per the plugin <-> integration contract.
                const timeout = parseLongPollTimeoutMs(url.searchParams.get('timeout'));
                jsonReply(response, 200, await this.waitForEvents(after, timeout)); return;
            }
            if (method === 'GET' && route === 'review') { jsonReply(response, 200, { items: this.db.listReview() }); return; }
            if (method === 'GET' && route === 'species') { jsonReply(response, 200, { items: this.db.speciesList() }); return; }
            if (method === 'GET' && route.startsWith('species/')) {
                const detail = await this.speciesDetail(route.slice('species/'.length));
                jsonReply(response, detail ? 200 : 404, detail ?? { error: 'Species not found' }); return;
            }
            if (method === 'GET' && route === 'labels') { jsonReply(response, 200, { labels: await this.labels() }); return; }
            if (method === 'GET' && route === 'health') { jsonReply(response, 200, await this.health()); return; }
            if (route === 'settings' && method === 'GET') { jsonReply(response, 200, await this.settingsGet()); return; }
            if (route === 'settings' && method === 'PUT') { jsonReply(response, 200, await this.settingsPut(parseJsonBody(request.body))); return; }
            if (method === 'GET' && route === 'corrections/export') { jsonReply(response, 200, await this.correctionsExport()); return; }
            if (method === 'POST' && route === 'corrections/retrained') {
                const body = parseJsonBody(request.body);
                const at = asNumber(body.at);
                if (!at || at < 0) throw Object.assign(new Error('at must be a millisecond timestamp'), { status: 400 });
                this.db.markRetrained(at);
                jsonReply(response, 200, { retrainedAt: at, sinceRetrain: 0 }); return;
            }
            if (parts[0] === 'visits' && parts[1] && parts.length === 2 && method === 'GET') {
                const visit = this.db.getVisit(parts[1]);
                jsonReply(response, visit ? 200 : 404, visit ?? { error: 'Visit not found' }); return;
            }
            if (parts[0] === 'visits' && parts[1] && parts.length === 3 && method === 'POST') {
                const id = parts[1];
                if (parts[2] === 'correct') {
                    const body = parseJsonBody(request.body);
                    if (typeof body.species !== 'string') throw Object.assign(new Error('species is required'), { status: 400 });
                    jsonReply(response, 200, await this.correctVisit(id, body.species)); return;
                }
                if (parts[2] === 'confirm') {
                    const body = parseJsonBody(request.body);
                    jsonReply(response, 200, await this.confirmVisit(id, body.also_heard === true)); return;
                }
                if (parts[2] === 'undo') { jsonReply(response, 200, this.undoVisit(id)); return; }
            }
            jsonReply(response, 404, { error: 'Not found' });
        } catch (error) {
            const status = typeof error === 'object' && error && 'status' in error ? Number((error as { status: number }).status) : 400;
            this.console.warn(`Kestrel API request failed at ${route}: ${String(error)}`);
            jsonReply(response, status, { error: error instanceof Error ? error.message : 'Request failed' });
        }
    }

    async onRequest(request: HttpRequest, response: HttpResponse): Promise<void> {
        try {
            await this.ready;
            await this.handleApi(request, response);
        } catch (error) {
            this.console.error(`Kestrel request could not be served: ${String(error)}`);
            jsonReply(response, 503, { error: 'Kestrel is not ready' });
        }
    }

    private startTimers(): void {
        this.clipTimer = setInterval(() => { void this.pollClips().catch(error => this.console.warn(`Clip maintenance failed: ${String(error)}`)); }, CLIP_POLL_MS);
        this.healthTimer = setInterval(() => { void this.refreshCameraStatus().catch(error => this.console.warn(`Camera status refresh failed: ${String(error)}`)); }, 30_000);
        this.scheduleMaintenance();
    }

    private scheduleMaintenance(): void {
        const next = new Date();
        next.setHours(3, 30, 0, 0);
        if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
        this.maintenanceTimer = setTimeout(async () => {
            try {
                await this.db.prune(Date.now(), this.mediaDirs?.root ?? this.baseDir, MEDIA_BUDGET_BYTES);
            } catch (error) {
                this.console.error(`Kestrel nightly storage maintenance failed: ${String(error)}`);
            }
            if (!this.released) this.scheduleMaintenance();
        }, next.getTime() - Date.now());
    }

    async release(): Promise<void> {
        this.released = true;
        ++this.brokerGeneration;
        for (const listener of this.cameraListeners.values()) listener.removeListener();
        this.cameraListeners.clear();
        for (const listener of this.onlineListeners.values()) listener.removeListener();
        this.onlineListeners.clear();
        for (const pending of this.pending.values()) clearTimeout(pending.timer);
        this.pending.clear();
        for (const session of this.detectorSessions.values()) clearTimeout(session.timer);
        this.detectorSessions.clear();
        if (this.client) this.client.end(true);
        if (this.clipTimer) clearInterval(this.clipTimer);
        if (this.healthTimer) clearInterval(this.healthTimer);
        if (this.maintenanceTimer) clearTimeout(this.maintenanceTimer);
        for (const wake of this.eventWaiters) wake();
        this.eventWaiters.clear();
        this.store?.close();
    }
}

export default new Kestrel();
