import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Camera, ImageEmbedding, MediaObject, ObjectDetection, ObjectDetector } from '@scrypted/sdk';
import { LIVE_PICTURE_QUALITY, LIVE_PICTURE_WIDTH } from './live';
import { sdk } from './sdkFix';

interface SharpPipeline {
    metadata(): Promise<{ width?: number; height?: number }>;
    rotate(): SharpPipeline;
    resize(options: { width?: number; height?: number; fit?: 'inside'; withoutEnlargement?: boolean }): SharpPipeline;
    extract(options: { left: number; top: number; width: number; height: number }): SharpPipeline;
    jpeg(options: { quality: number }): SharpPipeline;
    toBuffer(): Promise<Buffer>;
}

interface SharpModule {
    (input: Buffer): SharpPipeline;
}

declare const __non_webpack_require__: (id: string) => unknown;
const sharp = __non_webpack_require__('sharp') as SharpModule;

export interface CapturedImage {
    snapshot: Buffer;
    crop: Buffer;
}

export async function ensureMediaDirectories(base: string): Promise<{ root: string; snapshots: string; crops: string; audio: string }> {
    const root = join(base, 'media');
    const snapshots = join(root, 'snap');
    const crops = join(root, 'crop');
    const audio = join(root, 'audio');
    await Promise.all([mkdir(snapshots, { recursive: true }), mkdir(crops, { recursive: true }), mkdir(audio, { recursive: true })]);
    return { root, snapshots, crops, audio };
}

export async function captureDetection(cameraId: string, detectionId: string | undefined, box?: number[]): Promise<CapturedImage> {
    const camera = sdk.systemManager.getDeviceById(cameraId) as unknown as ObjectDetector & Camera;
    let source: MediaObject;
    if (detectionId && typeof camera.getDetectionInput === 'function') {
        try {
            source = await camera.getDetectionInput(detectionId);
        } catch {
            source = await camera.takePicture({ reason: 'event', timeout: 10_000 });
        }
    } else {
        source = await camera.takePicture({ reason: 'event', timeout: 10_000 });
    }
    const original = await sdk.mediaManager.convertMediaObjectToBuffer(source, 'image/jpeg');
    const image = sharp(original).rotate();
    const metadata = await image.metadata();
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (!width || !height)
        throw new Error('Scrypted returned an image without dimensions');

    const snapshot = await sharp(original).rotate().resize({ width: 1280, withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
    let [x, y, boxWidth, boxHeight] = box ?? [];
    if (boxWidth > 0 && boxHeight > 0) {
        if (Math.max(Math.abs(x), Math.abs(y), Math.abs(boxWidth), Math.abs(boxHeight)) <= 1) {
            x *= width; y *= height; boxWidth *= width; boxHeight *= height;
        }
        const marginX = boxWidth * 0.12;
        const marginY = boxHeight * 0.12;
        const left = Math.max(0, Math.floor(x - marginX));
        const top = Math.max(0, Math.floor(y - marginY));
        const right = Math.min(width, Math.ceil(x + boxWidth + marginX));
        const bottom = Math.min(height, Math.ceil(y + boxHeight + marginY));
        box = [left, top, Math.max(1, right - left), Math.max(1, bottom - top)];
    } else {
        const side = Math.min(width, height, 384);
        box = [Math.floor((width - side) / 2), Math.floor((height - side) / 2), side, side];
    }
    const crop = await sharp(original).rotate().extract({ left: box[0], top: box[1], width: box[2], height: box[3] })
        .resize({ width: 384, height: 384, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
    return { snapshot, crop };
}

export async function saveCapture(directories: { snapshots: string; crops: string }, id: string, capture: CapturedImage): Promise<{ snapshotFile: string; cropFile: string }> {
    const snapshotFile = join(directories.snapshots, `${id}.jpg`);
    const cropFile = join(directories.crops, `${id}.jpg`);
    await Promise.all([writeFile(snapshotFile, capture.snapshot), writeFile(cropFile, capture.crop)]);
    return { snapshotFile, cropFile };
}

export async function embedCrop(crop: Buffer): Promise<Buffer | undefined> {
    const device = sdk.systemManager.getDeviceById('227') as unknown as ImageEmbedding;
    if (!device || typeof device.getImageEmbedding !== 'function')
        return undefined;
    const media = await sdk.mediaManager.createMediaObject(crop, 'image/jpeg');
    return device.getImageEmbedding(media);
}

// What the wildlife classifier (Scrypted device 248) makes of a crop: its best guesses with their confidence. Scrypted's NVR
// puts a label on a detection only when the classifier is at least 70% sure and never passes the confidence on, so it is
// asked directly. Rejects when the classifier does not answer in time.
export async function classifyCrop(crop: Buffer, timeoutMs: number): Promise<{ className: string; score: number }[]> {
    const classifier = sdk.systemManager.getDeviceById('248') as unknown as ObjectDetection | undefined;
    if (!classifier || typeof classifier.detectObjects !== 'function')
        return [];
    const media = await sdk.mediaManager.createMediaObject(crop, 'image/jpeg');
    let timer: NodeJS.Timeout | undefined;
    try {
        const result = await Promise.race([
            classifier.detectObjects(media),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('The classifier did not answer in time')), timeoutMs); }),
        ]);
        return (result.detections ?? []).filter(item => typeof item.score === 'number').map(item => ({ className: item.className, score: item.score }));
    } finally {
        clearTimeout(timer);
    }
}

// One current picture from the camera for a Live tile: a periodic request (the camera plugin may answer
// from its own recent cache instead of waking the camera), at most 960 px wide, re-encoded as JPEG q75 so
// every camera gives the same small size whatever it returns. Rejects when the camera cannot take one.
export async function captureLivePicture(cameraId: string, timeoutMs: number): Promise<Buffer> {
    const camera = sdk.systemManager.getDeviceById(cameraId) as unknown as Camera | undefined;
    if (!camera || typeof camera.takePicture !== 'function')
        throw new Error(`Camera ${cameraId} cannot take pictures`);
    const media = await camera.takePicture({ reason: 'periodic', periodicRequest: true, timeout: timeoutMs, picture: { width: LIVE_PICTURE_WIDTH } });
    const original = await sdk.mediaManager.convertMediaObjectToBuffer(media, 'image/jpeg');
    return sharp(original).rotate().resize({ width: LIVE_PICTURE_WIDTH, withoutEnlargement: true }).jpeg({ quality: LIVE_PICTURE_QUALITY }).toBuffer();
}
