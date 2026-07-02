import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { retrieve } from '../index.ts';
import type { RetrieveOptions } from '../index.ts';
import type { Index, IndexedChunk } from '../../../rag/src/index.ts';

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

/** Опции по умолчанию для теста: без префикса, без порога, без rerank. */
const opts = (over: Partial<RetrieveOptions> = {}): RetrieveOptions => ({
  k: 2,
  kPre: 5,
  queryPrefix: '',
  minScore: 0,
  rerank: 'none',
  mmrLambda: 0.7,
  ...over,
});

describe('retrieve', () => {
  it('эмбеддит запрос, берёт top-kPre по косинусу и срезает до k; трасса заполнена', async () => {
    const index = idx([ch('A', [1, 0]), ch('B', [0, 1]), ch('C', [1, 1])]);
    const { results, trace } = await retrieve('вопрос', [index], opts({ k: 2, kPre: 3 }), embed);
    assert.deepEqual(
      results.map(r => r.chunk.chunk_id),
      ['A', 'C'], // A(cos=1) ближе C(≈0.707); B(0) отсечён срезом k=2
    );
    assert.deepEqual(trace, {
      rewritten: false,
      candidates: 3,
      minScore: 0,
      afterThreshold: 3,
      rerank: 'none',
      returned: 2,
    });
  });

  it('несколько индексов объединяются; пустой вход → пусто', async () => {
    const empty = await retrieve('q', [], opts({ k: 2, kPre: 3 }), embed);
    assert.deepEqual(empty.results, []);
    assert.equal(empty.trace.candidates, 0);
    const merged = await retrieve(
      'q',
      [idx([ch('A', [1, 0])]), idx([ch('B', [1, 1])])],
      opts({ k: 5, kPre: 5 }),
      embed,
    );
    assert.deepEqual(
      merged.results.map(r => r.chunk.chunk_id),
      ['A', 'B'],
    );
  });

  it('queryPrefix добавляется к запросу перед эмбеддингом', async () => {
    const seen: string[] = [];
    const capturing = async (inputs: string[]): Promise<number[][]> => {
      seen.push(...inputs);
      return [[1, 0]];
    };
    await retrieve(
      'вопрос',
      [idx([ch('A', [1, 0])])],
      opts({ k: 1, kPre: 1, queryPrefix: 'search_query: ' }),
      capturing,
    );
    assert.deepEqual(seen, ['search_query: вопрос']);
  });

  it('minScore отсекает чанки ниже порога; трасса показывает до/после', async () => {
    const index = idx([ch('A', [1, 0]), ch('B', [0, 1]), ch('C', [1, 1])]);
    const { results, trace } = await retrieve(
      'q',
      [index],
      opts({ k: 5, kPre: 5, minScore: 0.5 }),
      embed,
    );
    assert.deepEqual(
      results.map(r => r.chunk.chunk_id),
      ['A', 'C'], // B(cos=0) отсечён порогом 0.5
    );
    assert.equal(trace.candidates, 3);
    assert.equal(trace.afterThreshold, 2);
    assert.equal(trace.minScore, 0.5);
  });

  it('hook rewrite меняет текст для эмбеддинга, но не запрос для rerank; трасса rewritten=true', async () => {
    const embedded: string[] = [];
    const capturing = async (inputs: string[]): Promise<number[][]> => {
      embedded.push(...inputs);
      return [[1, 0]];
    };
    let rerankQuery = '';
    const { results, trace } = await retrieve(
      'исходный',
      [idx([ch('A', [1, 0]), ch('B', [0, 1])])],
      opts({ k: 2, kPre: 2, rerank: 'llm' }),
      capturing,
      {
        rewrite: async () => 'переписанный',
        rerankLlm: async (query, candidates) => {
          rerankQuery = query;
          return candidates;
        },
      },
    );
    assert.deepEqual(embedded, ['переписанный']); // эмбеддится переписанный текст
    assert.equal(rerankQuery, 'исходный'); // rerank судит по исходному запросу
    assert.equal(results.length, 2);
    assert.equal(trace.rewritten, true);
    assert.equal(trace.rerank, 'llm');
  });

  it('rerank=llm без хука деградирует до none (трасса rerank=none)', async () => {
    const index = idx([ch('A', [1, 0]), ch('B', [1, 1])]);
    const { results, trace } = await retrieve(
      'q',
      [index],
      opts({ k: 2, kPre: 2, rerank: 'llm' }),
      embed,
    );
    assert.deepEqual(
      results.map(r => r.chunk.chunk_id),
      ['A', 'B'],
    );
    assert.equal(trace.rerank, 'none');
  });

  it('rerank=llm с хуком применяет переранжирование хука', async () => {
    const index = idx([ch('A', [1, 0]), ch('B', [1, 1])]);
    const { results } = await retrieve(
      'q',
      [index],
      opts({ k: 2, kPre: 2, rerank: 'llm' }),
      embed,
      { rerankLlm: async (_query, candidates) => [...candidates].reverse() },
    );
    assert.deepEqual(
      results.map(r => r.chunk.chunk_id),
      ['B', 'A'], // хук перевернул порядок
    );
  });

  it('rerank=mmr переранжирует результаты (штрафует почти-дубли)', async () => {
    // Запрос [1,0]. A и B почти совпадают (дубли), C — непохожий и менее релевантный. По score
    // порядок A,B,C; MMR при низкой lambda поднимает разнообразный C над дублирующим B.
    const index = idx([ch('A', [2, 1]), ch('B', [2, 1.05]), ch('C', [1, 2])]);
    const plain = await retrieve('q', [index], opts({ k: 3, kPre: 3, rerank: 'none' }), embed);
    assert.deepEqual(
      plain.results.map(r => r.chunk.chunk_id),
      ['A', 'B', 'C'],
    );
    const diversified = await retrieve(
      'q',
      [index],
      opts({ k: 3, kPre: 3, rerank: 'mmr', mmrLambda: 0.2 }),
      embed,
    );
    assert.deepEqual(
      diversified.results.map(r => r.chunk.chunk_id),
      ['A', 'C', 'B'], // C поднят над дублирующим B
    );
    assert.equal(diversified.trace.rerank, 'mmr');
  });
});
