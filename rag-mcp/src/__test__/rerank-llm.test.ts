import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseScores, makeChatRerankProvider, makeLlmReranker } from '../index.ts';
import type { ChatComplete, RerankProvider } from '../index.ts';
import type { IndexedChunk, ScoredChunk } from '../../../rag/src/index.ts';

const scored = (id: string, score: number, text = id): ScoredChunk => ({
  chunk: {
    chunk_id: id,
    source: 's',
    file: 'f',
    title: 't',
    section: 'sec',
    text,
    embedding: [1, 0],
  } satisfies IndexedChunk,
  score,
});

describe('parseScores', () => {
  it('корректный JSON-массив нужной длины → скоры, без фолбэка', () => {
    assert.deepEqual(parseScores('[0.9, 0.1, 0.5]', 3), {
      scores: [0.9, 0.1, 0.5],
      fallback: false,
    });
  });

  it('массив в прозе извлекается', () => {
    assert.deepEqual(parseScores('Вот оценки: [0.8, 0.2]. Готово.', 2), {
      scores: [0.8, 0.2],
      fallback: false,
    });
  });

  it('нечисловой элемент → 0', () => {
    assert.deepEqual(parseScores('[0.7, "нет", null]', 3), {
      scores: [0.7, 0, 0],
      fallback: false,
    });
  });

  it('нет массива → фолбэк со скорами-заглушкой (убывают по позиции)', () => {
    assert.deepEqual(parseScores('не знаю', 3), { scores: [3, 2, 1], fallback: true });
  });

  it('нет закрывающей скобки (регекс не находит массив) → фолбэк', () => {
    assert.deepEqual(parseScores('[0.9, 0.1', 2), { scores: [2, 1], fallback: true });
  });

  it('скобки есть, но JSON битый (парсер бросает) → фолбэк', () => {
    assert.deepEqual(parseScores('[0.9, , 0.1]', 2), { scores: [2, 1], fallback: true });
  });

  it('неверная длина массива → фолбэк', () => {
    assert.deepEqual(parseScores('[0.9]', 3), { scores: [3, 2, 1], fallback: true });
  });
});

describe('makeChatRerankProvider', () => {
  it('нумерует фрагменты в промпте и парсит ответ в скоры', async () => {
    let userPrompt = '';
    const complete: ChatComplete = async (_system, user) => {
      userPrompt = user;
      return '[0.2, 0.9]';
    };
    const provider = makeChatRerankProvider(complete);
    const result = await provider('запрос', ['первый', 'второй']);
    assert.deepEqual(result, { scores: [0.2, 0.9], fallback: false });
    assert.match(userPrompt, /\[0\] первый/);
    assert.match(userPrompt, /\[1\] второй/);
    assert.match(userPrompt, /Запрос: запрос/);
  });
});

describe('makeLlmReranker', () => {
  it('пустой вход → как есть, без фолбэка (провайдер не вызывается)', async () => {
    let called = false;
    const provider: RerankProvider = async () => {
      called = true;
      return { scores: [], fallback: false };
    };
    assert.deepEqual(await makeLlmReranker(provider)('q', []), { results: [], fallback: false });
    assert.equal(called, false);
  });

  it('успех: заменяет score скорами провайдера и сортирует по убыванию', async () => {
    const provider: RerankProvider = async () => ({ scores: [0.1, 0.9], fallback: false });
    const reranker = makeLlmReranker(provider);
    const { results, fallback } = await reranker('q', [scored('A', 0.8), scored('B', 0.7)]);
    assert.equal(fallback, false);
    assert.deepEqual(
      results.map(r => ({ id: r.chunk.chunk_id, score: r.score })),
      [
        { id: 'B', score: 0.9 },
        { id: 'A', score: 0.1 },
      ],
    );
  });

  it('успех, но недостающий скор → исходный score кандидата', async () => {
    const provider: RerankProvider = async () => ({ scores: [0.5], fallback: false }); // короче кандидатов
    const reranker = makeLlmReranker(provider);
    const { results } = await reranker('q', [scored('A', 0.3), scored('B', 0.99)]);
    // B без скора провайдера сохраняет свой 0.99 и выходит вперёд.
    assert.deepEqual(
      results.map(r => r.chunk.chunk_id),
      ['B', 'A'],
    );
  });

  it('фолбэк провайдера → кандидаты как есть (исходные скоры/порядок), fallback=true', async () => {
    const provider: RerankProvider = async () => ({ scores: [2, 1], fallback: true });
    const reranker = makeLlmReranker(provider);
    const { results, fallback } = await reranker('q', [scored('A', 0.3), scored('B', 0.99)]);
    assert.equal(fallback, true);
    // Порядок и скоры не тронуты (без фейковых чисел) — дальше решает конвейер (MMR).
    assert.deepEqual(
      results.map(r => ({ id: r.chunk.chunk_id, score: r.score })),
      [
        { id: 'A', score: 0.3 },
        { id: 'B', score: 0.99 },
      ],
    );
  });
});
