export const LEARNING_MIN_CORRECTIONS = 3;
export const LEARNING_COSINE_THRESHOLD = 0.9;

export interface LearningExample {
    cameraId: string;
    from: string;
    to: string;
    embedding: Float32Array;
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (!a.length || a.length !== b.length)
        return -1;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
        const av = a[i];
        const bv = b[i];
        dot += av * bv;
        normA += av * av;
        normB += bv * bv;
    }
    if (!normA || !normB)
        return -1;
    return dot / Math.sqrt(normA * normB);
}

/**
 * A relabel is learned only from three reviewed examples for this exact
 * camera/from/to mapping. The mean of their three closest similarities must
 * meet the conservative threshold, so one accidental close match is not
 * enough to relabel a visit.
 */
export function chooseLearnedLabel(
    cameraId: string,
    from: string,
    query: Float32Array,
    examples: readonly LearningExample[],
    minimumCorrections = LEARNING_MIN_CORRECTIONS,
    threshold = LEARNING_COSINE_THRESHOLD,
): string | undefined {
    const groups = new Map<string, number[]>();
    for (const example of examples) {
        if (example.cameraId !== cameraId || example.from !== from || !example.to || example.to === from)
            continue;
        const similarity = cosineSimilarity(query, example.embedding);
        if (similarity < -0.5)
            continue;
        const scores = groups.get(example.to) ?? [];
        scores.push(similarity);
        groups.set(example.to, scores);
    }

    let learned: string | undefined;
    let learnedScore = threshold;
    for (const [to, scores] of groups) {
        if (scores.length < minimumCorrections)
            continue;
        scores.sort((a, b) => b - a);
        const average = (scores[0] + scores[1] + scores[2]) / 3;
        if (average >= learnedScore) {
            learned = to;
            learnedScore = average;
        }
    }
    return learned;
}

export function embeddingFromBuffer(buffer: Buffer): Float32Array | undefined {
    if (!buffer.length || buffer.byteLength % Float32Array.BYTES_PER_ELEMENT)
        return undefined;
    const values = new Float32Array(buffer.byteLength / Float32Array.BYTES_PER_ELEMENT);
    for (let i = 0; i < values.length; i++)
        values[i] = buffer.readFloatLE(i * Float32Array.BYTES_PER_ELEMENT);
    return values;
}

export function embeddingToBuffer(embedding: Float32Array): Buffer {
    const buffer = Buffer.allocUnsafe(embedding.length * Float32Array.BYTES_PER_ELEMENT);
    for (let i = 0; i < embedding.length; i++)
        buffer.writeFloatLE(embedding[i], i * Float32Array.BYTES_PER_ELEMENT);
    return buffer;
}
