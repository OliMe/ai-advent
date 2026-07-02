import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mmrRerank } from '../index.ts';
import type { IndexedChunk, ScoredChunk } from '../../../rag/src/index.ts';

const scored = (id: string, embedding: number[], score: number): ScoredChunk => ({
  chunk: {
    chunk_id: id,
    source: 's',
    file: 'f',
    title: 't',
    section: 'sec',
    text: id,
    embedding,
  } satisfies IndexedChunk,
  score,
});

describe('mmrRerank', () => {
  it('пустой вход или limit 0 → пусто', () => {
    assert.deepEqual(mmrRerank([], 5, 0.7), []);
    assert.deepEqual(mmrRerank([scored('A', [1, 0], 1)], 0, 0.7), []);
  });

  it('lambda=1 (чистая релевантность) → порядок по score', () => {
    const result = mmrRerank(
      [scored('A', [1, 0], 0.9), scored('B', [0, 1], 0.7), scored('C', [1, 1], 0.8)],
      3,
      1,
    );
    assert.deepEqual(
      result.map(r => r.chunk.chunk_id),
      ['A', 'C', 'B'],
    );
  });

  it('низкая lambda штрафует почти-дубли: непохожий поднимается над дублем', () => {
    // A и B почти совпадают; C ортогонален. Все с близким score → разнообразие решает.
    const result = mmrRerank(
      [scored('A', [1, 0], 0.9), scored('B', [0.99, 0.01], 0.88), scored('C', [0, 1], 0.85)],
      3,
      0.3,
    );
    assert.deepEqual(
      result.map(r => r.chunk.chunk_id),
      ['A', 'C', 'B'],
    );
  });

  it('limit ограничивает число отобранных', () => {
    const result = mmrRerank(
      [scored('A', [1, 0], 0.9), scored('B', [0, 1], 0.8), scored('C', [1, 1], 0.7)],
      2,
      0.7,
    );
    assert.equal(result.length, 2);
  });
});
