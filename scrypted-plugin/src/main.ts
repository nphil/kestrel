import type { Setting, Settings, SettingValue } from '@scrypted/sdk';
import { ScryptedDeviceBase, ScryptedInterface } from '@scrypted/sdk';
import mqtt, { type MqttClient } from 'mqtt';
import { sdk } from './sdkFix';

const { systemManager } = sdk;
const DEFAULT_PREFIX = 'homeassistant';
const DEFAULT_COOLDOWN = 10;
const UNIDENTIFIED_GRACE_MS = 30_000;
const CAMERA_SETTING = 'cameras';
const SETTINGS: Setting[] = [
    { key: CAMERA_SETTING, title: 'Cameras to watch', description: 'Choose VideoCamera devices. Only animal detections publish visits.', type: 'device', deviceFilter: 'VideoCamera', multiple: true },
    { key: 'cooldownMinutes', title: 'Cooldown minutes', description: 'Minimum time before the same species can create another visit on the same camera.', type: 'number', value: DEFAULT_COOLDOWN },
    { key: 'brokerUrl', title: 'MQTT broker URL', type: 'string' },
    { key: 'username', title: 'MQTT username', type: 'string' },
    { key: 'password', title: 'MQTT password', type: 'password' },
    { key: 'discoveryPrefix', title: 'Discovery prefix', type: 'string', value: DEFAULT_PREFIX },
];

type Detection = { className?: string; label?: string | null; score?: number | null; id?: string };
type DetectionEvent = { detections?: Detection[]; detectionId?: string; timestamp?: number };
type CameraInfo = { id: string; name: string; eventTypes: string[]; slug: string };

function slugify(value: string): string {
    return value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'camera';
}

function parseIds(value: unknown): string[] {
    if (Array.isArray(value)) return value.map(String).filter(Boolean);
    if (typeof value !== 'string' || !value) return [];
    try {
        const parsed: unknown = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : value.split(',').map(v => v.trim()).filter(Boolean);
    } catch {
        return value.split(',').map(v => v.trim()).filter(Boolean);
    }
}

class WildlifeVisits extends ScryptedDeviceBase implements Settings {
    private client?: MqttClient;
    private listeners = new Map<string, { removeListener(): void }>();
    private cameras = new Map<string, CameraInfo>();
    private cooldowns = new Map<string, number>();
    private pendingUnidentified = new Map<string, NodeJS.Timeout>();
    private setupGeneration = 0;
    private brokerGeneration = 0;

    async getSettings(): Promise<Setting[]> {
        return SETTINGS.map(setting => ({ ...setting, value: setting.key === CAMERA_SETTING ? parseIds(this.storage.getItem(setting.key || '')) : this.storage.getItem(setting.key || '') ?? setting.value ?? '' }));
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        this.storage.setItem(key, key === CAMERA_SETTING ? JSON.stringify(parseIds(value)) : String(value ?? ''));
        if (SETTINGS.some(setting => setting.key === key)) await this.reconfigure();
    }

    private async readCameras(): Promise<CameraInfo[]> {
        const selected = parseIds(this.storage.getItem(CAMERA_SETTING));
        const result: CameraInfo[] = [];
        for (const id of selected) {
            const device = systemManager.getDeviceById(id) as unknown as Settings & { id: string; name: string; interfaces: string[] };
            if (!device || !device.interfaces?.includes(ScryptedInterface.VideoCamera)) continue;
            const settings = await device.getSettings();
            const attached = settings.find(setting => setting.key === 'objectdetectionplugin:134:animalClassifiers')?.value;
            const classifierIds = parseIds(attached);
            const labels = new Set<string>(['Unidentified animal']);
            for (const classifierId of classifierIds) {
                const classifier = systemManager.getDeviceById(classifierId) as unknown as Settings;
                if (!classifier) continue;
                const classifierSettings = await classifier.getSettings();
                for (const label of classifierSettings.find(setting => setting.key === 'excludeClasses')?.choices ?? []) labels.add(String(label));
            }
            result.push({ id, name: device.name, eventTypes: [...labels].sort(), slug: slugify(device.name) });
        }
        return result;
    }

    private async reconfigure(): Promise<void> {
        const generation = ++this.setupGeneration;
        for (const listener of this.listeners.values()) listener.removeListener();
        this.listeners.clear();
        const selected = await this.readCameras();
        if (generation !== this.setupGeneration) return;
        const oldCameras = this.cameras;
        this.cameras = new Map(selected.map(camera => [camera.id, camera]));
        this.refreshBroker(oldCameras);
        for (const camera of selected) {
            const listener = systemManager.listenDevice(camera.id, ScryptedInterface.ObjectDetector, (_source, _details, data) => {
                void this.onDetection(camera.id, data as DetectionEvent);
            });
            this.listeners.set(camera.id, listener);
        }
    }

    private refreshBroker(oldCameras: Map<string, CameraInfo>): void {
        const brokerUrl = this.storage.getItem('brokerUrl')?.trim();
        const generation = ++this.brokerGeneration;
        if (this.client) {
            this.client.removeAllListeners();
            this.client.end(true);
            this.client = undefined;
        }
        if (!brokerUrl) return;
        const prefix = (this.storage.getItem('discoveryPrefix') || DEFAULT_PREFIX).replace(/\/+$/, '');
        const client = mqtt.connect(brokerUrl, {
            username: this.storage.getItem('username') || undefined,
            password: this.storage.getItem('password') || undefined,
            will: { topic: 'wildlife-visits/availability', payload: 'offline', qos: 1, retain: true },
            reconnectPeriod: 3000,
        });
        this.client = client;
        client.on('connect', () => {
            if (generation !== this.brokerGeneration) return;
            client.publish('wildlife-visits/availability', 'online', { qos: 1, retain: true });
            for (const removed of oldCameras.values()) {
                if (!this.cameras.has(removed.id)) client.publish(`${prefix}/event/wildlife_visits_${removed.slug}_animal/config`, '', { qos: 1, retain: true });
            }
            this.publishDiscovery(prefix);
            client.subscribe(`${prefix}/status`, { qos: 1 });
        });
        client.on('message', (topic, payload) => {
            if (topic === `${prefix}/status` && payload.toString() === 'online') this.publishDiscovery(prefix);
        });
        client.on('error', error => this.console.warn(`MQTT connection error: ${error.message}`));
    }

    private publishDiscovery(prefix: string): void {
        const client = this.client;
        if (!client?.connected) return;
        const device = { identifiers: ['wildlife_visits'], name: 'Wildlife Visits', manufacturer: 'nphil', model: 'Wildlife Classifier for Scrypted' };
        for (const camera of this.cameras.values()) {
            const topic = `${prefix}/event/wildlife_visits_${camera.slug}_animal/config`;
            client.publish(topic, JSON.stringify({
                name: `${camera.name} Animal`, unique_id: `wildlife_visits_${camera.id}`,
                object_id: `wildlife_visits_${camera.slug}_animal`, icon: 'mdi:paw', event_types: camera.eventTypes, has_entity_name: false,
                state_topic: `wildlife-visits/${camera.id}/visit`, value_template: '{{ value_json | tojson }}', json_attributes_topic: `wildlife-visits/${camera.id}/visit`,
                availability_topic: 'wildlife-visits/availability',
                payload_available: 'online', payload_not_available: 'offline', device,
            }), { qos: 1, retain: true });
        }
    }

    private async onDetection(cameraId: string, event: DetectionEvent): Promise<void> {
        const camera = this.cameras.get(cameraId);
        if (!camera || !this.client?.connected) return;
        for (const detection of event?.detections ?? []) {
            if (detection.className !== 'animal') continue;
            if (detection.label) {
                // A named animal settles the camera's pending "unidentified" visit: it was this one.
                clearTimeout(this.pendingUnidentified.get(cameraId));
                this.pendingUnidentified.delete(cameraId);
                this.publishVisit(camera, detection.label, detection, event);
            } else if (!this.pendingUnidentified.has(cameraId)) {
                // The NVR reports an animal before its classifier has named it. Only call it
                // unidentified if no name arrives on this camera within the grace period.
                this.pendingUnidentified.set(cameraId, setTimeout(() => {
                    this.pendingUnidentified.delete(cameraId);
                    this.publishVisit(camera, 'Unidentified animal', detection, event);
                }, UNIDENTIFIED_GRACE_MS));
            }
        }
    }

    private publishVisit(camera: CameraInfo, species: string, detection: Detection, event: DetectionEvent): void {
        const client = this.client;
        if (!client?.connected) return;
        const now = Date.now();
        const cooldownMs = Math.max(0, Number(this.storage.getItem('cooldownMinutes') || DEFAULT_COOLDOWN)) * 60_000;
        const cooldownKey = `${camera.id}\u0000${species}`;
        if (now - (this.cooldowns.get(cooldownKey) ?? 0) < cooldownMs) return;
        this.cooldowns.set(cooldownKey, now);
        const payload = {
            event_type: species, score: detection.score ?? null, camera: camera.name,
            detection_id: detection.id ?? event.detectionId ?? null, at: new Date(event.timestamp ?? now).toISOString(),
        };
        client.publish(`wildlife-visits/${camera.id}/visit`, JSON.stringify(payload), { qos: 1, retain: false });
        this.console.log(`Wildlife visit: ${camera.name} — ${species}`);
    }

    async release(): Promise<void> {
        ++this.setupGeneration;
        ++this.brokerGeneration;
        for (const listener of this.listeners.values()) listener.removeListener();
        this.listeners.clear();
        for (const timer of this.pendingUnidentified.values()) clearTimeout(timer);
        this.pendingUnidentified.clear();
        if (this.client) this.client.end(true);
    }

    constructor() {
        super();
        void this.reconfigure();
    }
}

export default new WildlifeVisits();
