// Two numbers on the AI check-up that cost something to find out. Dependency-free on purpose: main.ts imports this, and the unit
// tests import it directly without the Scrypted SDK.

export type GpuStats = { usedMiB: number | null; totalMiB: number | null; util: number | null };

// How long a reading of the GPU is used again. The check-up is opened by hand, so a reading from a moment ago is as good as a new one.
export const GPU_FRESH_MS = 20_000;

const unknownGpu = (): GpuStats => ({ usedMiB: null, totalMiB: null, util: null });

// The first line of `nvidia-smi --query-gpu=memory.used,memory.total,utilization.gpu --format=csv,noheader,nounits`: "16808, 24576, 5".
// Anything else (no GPU, "[N/A]", a missing field) is "unknown", never a made-up zero.
export function parseGpuStats(output: string): GpuStats {
    const fields = (output.trim().split(/\r?\n/)[0] ?? '').split(',').map(field => field.trim());
    if (fields.length !== 3 || !fields.every(field => /^\d+(\.\d+)?$/.test(field))) return unknownGpu();
    const [usedMiB, totalMiB, util] = fields.map(Number);
    return { usedMiB, totalMiB, util };
}

// Reads the GPU through `run` (the output of nvidia-smi) without ever holding anything up:
//  - `run` is asynchronous, so a slow GPU does not stop the rest of the plugin while it answers (the old synchronous call froze
//    detections and every web request for up to two seconds each time the check-up was opened);
//  - a reading is used again for `freshMs`, and callers that arrive while nvidia-smi is running share that one run;
//  - a GPU that cannot be read is remembered for as long as a reading is, so a machine without nvidia-smi does not start a
//    process for every health request.
export class GpuProbe {
    private readonly run: () => Promise<string>;
    private readonly now: () => number;
    private readonly freshMs: number;
    private cached: { at: number; stats: GpuStats } | undefined;
    private asking: Promise<GpuStats> | undefined;

    constructor(run: () => Promise<string>, options: { now?: () => number; freshMs?: number } = {}) {
        this.run = run;
        this.now = options.now ?? Date.now;
        this.freshMs = options.freshMs ?? GPU_FRESH_MS;
    }

    stats(): Promise<GpuStats> {
        if (this.cached && this.now() - this.cached.at < this.freshMs) return Promise.resolve(this.cached.stats);
        this.asking ??= this.ask();
        return this.asking;
    }

    private async ask(): Promise<GpuStats> {
        let stats: GpuStats;
        try {
            stats = parseGpuStats(await this.run());
        } catch {
            stats = unknownGpu();
        }
        this.cached = { at: this.now(), stats };
        this.asking = undefined;
        return stats;
    }
}

// The average of the last `size` durations, so a number on screen follows how the thing is doing now rather than since the plugin started.
export class RollingAverage {
    private readonly values: number[] = [];
    private readonly size: number;

    constructor(size: number) {
        this.size = Math.max(1, Math.floor(size));
    }

    add(value: number): void {
        if (!Number.isFinite(value) || value < 0) return;
        this.values.push(value);
        if (this.values.length > this.size) this.values.shift();
    }

    // null until something was measured.
    average(): number | null {
        if (!this.values.length) return null;
        return this.values.reduce((total, value) => total + value, 0) / this.values.length;
    }
}
