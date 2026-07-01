import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatResults, formatIndexes } from '../index.ts';
import type { Index, IndexedChunk, ScoredChunk } from '../../../rag/src/index.ts';

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

describe('formatResults', () => {
  it('пусто → сообщение «не найдено»', () => {
    assert.match(
      formatResults('вопрос', []),
      /По запросу «вопрос» релевантных фрагментов не найдено/,
    );
  });

  it('нумерует фрагменты с метками источника, оценкой и текстом', () => {
    const scored: ScoredChunk[] = [{ chunk: ch(), score: 0.831 }];
    const out = formatResults('как установить', scored);
    assert.match(out, /Найдено фрагментов: 1/);
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
