import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { computeIndexCacheKey, FileIndexCache } from '../index.ts';
import type { IndexCacheIo } from '../index.ts';
import type { Document, Index } from '../../../rag/src/index.ts';

const DOC_A: Document = { source: '/r', file: 'a.md', title: 'a', text: 'текст A' };
const DOC_B: Document = { source: '/r', file: 'b.md', title: 'b', text: 'текст B' };

/** Мок-индекс для проверки сохранения/загрузки. */
const INDEX: Index = {
  strategy: 'structural',
  model: 'pr-reviewer-docs',
  dimensions: 2,
  createdAt: 'now',
  chunks: [
    {
      chunk_id: 'a#0',
      source: '/r',
      file: 'a.md',
      title: 'a',
      section: '',
      text: 'текст A',
      embedding: [1, 2],
    },
  ],
};

describe('computeIndexCacheKey', () => {
  it('детерминирован: одинаковые доки → одинаковый ключ', () => {
    assert.equal(
      computeIndexCacheKey([DOC_A, DOC_B], 'structural', 'nomic'),
      computeIndexCacheKey([DOC_A, DOC_B], 'structural', 'nomic'),
    );
  });

  it('не зависит от порядка доков (сортировка по пути)', () => {
    assert.equal(
      computeIndexCacheKey([DOC_A, DOC_B], 'structural', 'nomic'),
      computeIndexCacheKey([DOC_B, DOC_A], 'structural', 'nomic'),
    );
  });

  it('доки с одинаковым путём не роняют сравнение (ветка равенства)', () => {
    const key = computeIndexCacheKey(
      [
        { source: '/r', file: 'a.md', title: 'a', text: 'один' },
        { source: '/r', file: 'a.md', title: 'a', text: 'два' },
      ],
      'structural',
      'nomic',
    );
    assert.match(key, /^[0-9a-f]{64}$/);
  });

  it('правка текста дока → другой ключ (инвалидация по содержимому)', () => {
    assert.notEqual(
      computeIndexCacheKey([DOC_A], 'structural', 'nomic'),
      computeIndexCacheKey([{ ...DOC_A, text: 'изменённый' }], 'structural', 'nomic'),
    );
  });

  it('смена стратегии или схемы эмбеддинга → другой ключ', () => {
    const base = computeIndexCacheKey([DOC_A], 'structural', 'nomic');
    assert.notEqual(base, computeIndexCacheKey([DOC_A], 'fixed', 'nomic'));
    assert.notEqual(base, computeIndexCacheKey([DOC_A], 'structural', 'bge'));
  });
});

/** IO-заглушка поверх Map (без ФС). */
function fakeIo(): IndexCacheIo & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    read: path => store.get(path) ?? null,
    write: (path, content) => void store.set(path, content),
  };
}

describe('FileIndexCache', () => {
  it('save → load: круговой путь возвращает тот же индекс по пути <каталог>/<ключ>.json', () => {
    const io = fakeIo();
    const cache = new FileIndexCache('/cache', io);
    cache.save('KEY', INDEX);
    assert.equal([...io.store.keys()][0], join('/cache', 'KEY.json'));
    assert.deepEqual(cache.load('KEY'), INDEX);
  });

  it('нет файла → null (пересбор)', () => {
    assert.equal(new FileIndexCache('/cache', fakeIo()).load('MISS'), null);
  });

  it('повреждённый JSON → null, а не ошибка', () => {
    const io = fakeIo();
    io.store.set(join('/cache', 'BAD.json'), 'не-json{');
    assert.equal(new FileIndexCache('/cache', io).load('BAD'), null);
  });
});
