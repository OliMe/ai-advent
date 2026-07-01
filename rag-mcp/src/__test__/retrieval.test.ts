import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rerank, retrieve } from '../index.ts';
import type { Index, IndexedChunk, ScoredChunk } from '../../../rag/src/index.ts';

const ch = (id: string, embedding: number[]): IndexedChunk => ({
  chunk_id: id,
  source: 's',
  file: 'f',
  title: 't',
  section: 'sec',
  text: id,
  embedding,
});

const idx = (chunks: IndexedChunk[]): Index => ({
  strategy: 'structural',
  model: 'm',
  dimensions: 2,
  createdAt: 't',
  chunks,
});

const embed = async (): Promise<number[][]> => [[1, 0]];

describe('rerank (проходная стадия, День 22)', () => {
  it('возвращает вход как есть', () => {
    const scored: ScoredChunk[] = [{ chunk: ch('A', [1, 0]), score: 1 }];
    assert.equal(rerank(scored), scored);
  });
});

describe('retrieve', () => {
  it('эмбеддит запрос, берёт top-kPre по косинусу и срезает до k', async () => {
    const index = idx([ch('A', [1, 0]), ch('B', [0, 1]), ch('C', [1, 1])]);
    const results = await retrieve('вопрос', [index], { k: 2, kPre: 3 }, embed);
    assert.deepEqual(
      results.map(r => r.chunk.chunk_id),
      ['A', 'C'], // A(cos=1) ближе C(≈0.707); B(0) отсечён срезом k=2
    );
  });

  it('несколько индексов объединяются; пустой вход → пусто', async () => {
    assert.deepEqual(await retrieve('q', [], { k: 2, kPre: 3 }, embed), []);
    const merged = await retrieve(
      'q',
      [idx([ch('A', [1, 0])]), idx([ch('B', [1, 1])])],
      { k: 5, kPre: 5 },
      embed,
    );
    assert.deepEqual(
      merged.map(r => r.chunk.chunk_id),
      ['A', 'B'],
    );
  });
});
