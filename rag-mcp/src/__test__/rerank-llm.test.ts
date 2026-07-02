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
  it('корректный JSON-массив нужной длины', () => {
    assert.deepEqual(parseScores('[0.9, 0.1, 0.5]', 3), [0.9, 0.1, 0.5]);
  });

  it('массив в прозе извлекается', () => {
    assert.deepEqual(parseScores('Вот оценки: [0.8, 0.2]. Готово.', 2), [0.8, 0.2]);
  });

  it('нечисловой элемент → 0', () => {
    assert.deepEqual(parseScores('[0.7, "нет", null]', 3), [0.7, 0, 0]);
  });

  it('нет массива → фолбэк, сохраняющий порядок (убывающие по позиции)', () => {
    assert.deepEqual(parseScores('не знаю', 3), [3, 2, 1]);
  });

  it('нет закрывающей скобки (регекс не находит массив) → фолбэк', () => {
    assert.deepEqual(parseScores('[0.9, 0.1', 2), [2, 1]);
  });

  it('скобки есть, но JSON битый (парсер бросает) → фолбэк', () => {
    assert.deepEqual(parseScores('[0.9, , 0.1]', 2), [2, 1]);
  });

  it('неверная длина массива → фолбэк', () => {
    assert.deepEqual(parseScores('[0.9]', 3), [3, 2, 1]);
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
    const scores = await provider('запрос', ['первый', 'второй']);
    assert.deepEqual(scores, [0.2, 0.9]);
    assert.match(userPrompt, /\[0\] первый/);
    assert.match(userPrompt, /\[1\] второй/);
    assert.match(userPrompt, /Запрос: запрос/);
  });
});

describe('makeLlmReranker', () => {
  it('пустой вход → как есть (провайдер не вызывается)', async () => {
    let called = false;
    const provider: RerankProvider = async () => {
      called = true;
      return [];
    };
    assert.deepEqual(await makeLlmReranker(provider)('q', []), []);
    assert.equal(called, false);
  });

  it('заменяет score скорами провайдера и сортирует по убыванию', async () => {
    const provider: RerankProvider = async () => [0.1, 0.9];
    const reranker = makeLlmReranker(provider);
    const result = await reranker('q', [scored('A', 0.8), scored('B', 0.7)]);
    assert.deepEqual(
      result.map(r => ({ id: r.chunk.chunk_id, score: r.score })),
      [
        { id: 'B', score: 0.9 },
        { id: 'A', score: 0.1 },
      ],
    );
  });

  it('недостающий скор → исходный score кандидата', async () => {
    const provider: RerankProvider = async () => [0.5]; // короче числа кандидатов
    const reranker = makeLlmReranker(provider);
    const result = await reranker('q', [scored('A', 0.3), scored('B', 0.99)]);
    // B без скора провайдера сохраняет свой 0.99 и выходит вперёд.
    assert.deepEqual(
      result.map(r => r.chunk.chunk_id),
      ['B', 'A'],
    );
  });
});
