import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cosineSimilarity, topK } from '../index.ts';
import type { IndexedChunk } from '../index.ts';

const chunk = (id: string, embedding: number[]): IndexedChunk => ({
  chunk_id: id,
  source: 's',
  file: 'f',
  title: 't',
  section: 'sec',
  text: id,
  embedding,
});

describe('cosineSimilarity', () => {
  it('одинаковое направление → 1, ортогональные → 0', () => {
    assert.equal(cosineSimilarity([1, 0], [2, 0]), 1);
    assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  });

  it('нулевой вектор → 0 (без деления на ноль)', () => {
    assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
  });
});

describe('topK', () => {
  it('возвращает k ближайших по убыванию близости', () => {
    const chunks = [chunk('far', [0, 1]), chunk('near', [1, 0]), chunk('mid', [1, 1])];
    const scored = topK([1, 0], chunks, 2);
    assert.equal(scored.length, 2);
    assert.equal(scored[0].chunk.chunk_id, 'near'); // cos=1
    assert.equal(scored[1].chunk.chunk_id, 'mid'); // cos≈0.707
    assert.ok(scored[0].score >= scored[1].score);
  });
});
