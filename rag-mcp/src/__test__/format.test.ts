import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatResults, formatTrace, formatIndexes } from '../index.ts';
import type { RetrieveTrace } from '../index.ts';
import type { Index, IndexedChunk, ScoredChunk } from '../../../rag/src/index.ts';

const trace = (over: Partial<RetrieveTrace> = {}): RetrieveTrace => ({
  rewritten: false,
  candidates: 20,
  minScore: 0,
  afterThreshold: 20,
  rerank: 'mmr',
  returned: 5,
  ...over,
});

const ch = (over: Partial<IndexedChunk> = {}): IndexedChunk => ({
  chunk_id: 'c',
  source: 'github.com/o/r',
  file: 'README.md',
  title: 'README.md',
  section: 'Установка',
  text: 'как установить пакет',
  embedding: [],
  ...over,
});

describe('formatTrace', () => {
  it('без порога и rewrite: кандидаты → rerank → итог', () => {
    assert.equal(
      formatTrace(trace({ candidates: 20, rerank: 'mmr', returned: 5 })),
      '🔎 кандидатов 20 → rerank(mmr): 5',
    );
  });

  it('с порогом и rewrite: показывает стадию фильтра и пометку переписывания', () => {
    assert.equal(
      formatTrace(
        trace({
          rewritten: true,
          candidates: 20,
          minScore: 0.3,
          afterThreshold: 8,
          rerank: 'llm',
          returned: 5,
        }),
      ),
      '🔎 кандидатов 20 → порог≥0.30: 8 → rerank(llm): 5, запрос переписан',
    );
  });
});

describe('formatResults', () => {
  it('пусто → сообщение «не найдено» + трасса', () => {
    const out = formatResults('вопрос', [], trace({ candidates: 0, returned: 0 }));
    assert.match(out, /По запросу «вопрос» релевантных фрагментов не найдено/);
    assert.match(out, /🔎 кандидатов 0/);
  });

  it('нумерует фрагменты с метками источника, оценкой и текстом; печатает трассу', () => {
    const scored: ScoredChunk[] = [{ chunk: ch(), score: 0.831 }];
    const out = formatResults('как установить', scored, trace({ candidates: 12, returned: 1 }));
    assert.match(out, /Найдено фрагментов: 1/);
    assert.match(out, /🔎 кандидатов 12 → rerank\(mmr\): 1/);
    assert.match(out, /\[1\] github\.com\/o\/r › README\.md › Установка \(0\.831\)/);
    assert.match(out, /как установить пакет/);
  });
});

describe('formatIndexes', () => {
  const index = (chunks: IndexedChunk[]): Index => ({
    strategy: 'structural',
    model: 'nomic-embed-text',
    dimensions: 768,
    createdAt: 't',
    chunks,
  });

  it('пусто → подсказка', () => {
    assert.match(formatIndexes([]), /Кэшированных индексов нет/);
  });

  it('перечисляет источник, стратегию, число чанков; пустой индекс → «(пусто)»', () => {
    const out = formatIndexes([index([ch()]), index([])]);
    assert.match(out, /Индексы \(2\)/);
    assert.match(out, /• github\.com\/o\/r \[structural\] — чанков: 1, модель: nomic-embed-text/);
    assert.match(out, /• \(пусто\) \[structural\] — чанков: 0/);
  });
});
