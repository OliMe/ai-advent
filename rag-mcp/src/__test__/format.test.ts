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
  confidence: 0.8,
  lowConfidence: false,
  rerank: 'mmr',
  rerankFallback: false,
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
  it('без порога и rewrite: кандидаты → rerank → итог + уверенность', () => {
    assert.equal(
      formatTrace(trace({ candidates: 20, rerank: 'mmr', returned: 5 })),
      '🔎 кандидатов 20 → rerank(mmr): 5 · уверенность 0.80',
    );
  });

  it('фолбэк LLM-реранка показывается как llm→mmr', () => {
    assert.equal(
      formatTrace(trace({ rerank: 'llm', rerankFallback: true, candidates: 20, returned: 5 })),
      '🔎 кандидатов 20 → rerank(llm→mmr): 5 · уверенность 0.80',
    );
  });

  it('низкая уверенность помечается «(низкая)»', () => {
    assert.equal(
      formatTrace(
        trace({
          candidates: 20,
          rerank: 'none',
          returned: 3,
          confidence: 0.42,
          lowConfidence: true,
        }),
      ),
      '🔎 кандидатов 20 → rerank(none): 3 · уверенность 0.42 (низкая)',
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
      '🔎 кандидатов 20 → порог≥0.30: 8 → rerank(llm): 5, запрос переписан · уверенность 0.80',
    );
  });
});

describe('formatResults', () => {
  it('пусто → сообщение «не найдено» + трасса', () => {
    const out = formatResults('вопрос', [], trace({ candidates: 0, returned: 0 }));
    assert.match(out, /По запросу «вопрос» релевантных фрагментов не найдено/);
    assert.match(out, /🔎 кандидатов 0/);
  });

  it('нумерует фрагменты с chunk_id, метками источника, оценкой и текстом; печатает трассу', () => {
    const scored: ScoredChunk[] = [{ chunk: ch({ chunk_id: 'readme#3' }), score: 0.831 }];
    const out = formatResults('как установить', scored, trace({ candidates: 12, returned: 1 }));
    assert.match(out, /Найдено фрагментов: 1/);
    assert.match(out, /🔎 кандидатов 12 → rerank\(mmr\): 1/);
    assert.match(out, /\[1\] readme#3 · github\.com\/o\/r › README\.md › Установка \(0\.831\)/);
    assert.match(out, /как установить пакет/);
  });

  it('низкая уверенность → пометка в результате (и для пустого, и для непустого)', () => {
    const low = trace({ confidence: 0.4, lowConfidence: true, returned: 1 });
    assert.match(
      formatResults('q', [], trace({ confidence: 0, lowConfidence: true, returned: 0 })),
      /⚠ Низкая уверенность контекста/,
    );
    assert.match(
      formatResults('q', [{ chunk: ch(), score: 0.4 }], low),
      /⚠ Низкая уверенность контекста \(лучший косинус 0\.40\)/,
    );
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
