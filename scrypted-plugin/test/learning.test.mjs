import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseLearnedLabel, cosineSimilarity } from '../src/learning.ts';

const vector = new Float32Array([1, 0, 0]);
const examples = (count, overrides = {}) => Array.from({ length: count }, () => ({
    cameraId: '88',
    from: 'Unidentified animal',
    to: 'Raccoon',
    embedding: vector,
    ...overrides,
}));

test('learns only after three matching corrections from the same camera and source label', () => {
    assert.equal(chooseLearnedLabel('88', 'Unidentified animal', vector, examples(2)), undefined);
    assert.equal(chooseLearnedLabel('88', 'Unidentified animal', vector, examples(3)), 'Raccoon');
    assert.equal(chooseLearnedLabel('103', 'Unidentified animal', vector, examples(3)), undefined);
    assert.equal(chooseLearnedLabel('88', 'Bird', vector, examples(3)), undefined);
});

test('uses a conservative cosine threshold and accepts a score exactly at the threshold', () => {
    assert.equal(cosineSimilarity(vector, vector), 1);
    assert.equal(chooseLearnedLabel('88', 'Unidentified animal', vector, examples(3), 3, 1), 'Raccoon');
    const different = new Float32Array([0, 1, 0]);
    assert.equal(chooseLearnedLabel('88', 'Unidentified animal', vector, examples(3, { embedding: different }), 3, 0.9), undefined);
});
