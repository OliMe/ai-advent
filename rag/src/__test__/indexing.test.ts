import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { JsonIndexStore, buildIndex, computeStats } from '../index.ts';
import type { Document, Index } from '../index.ts';

const doc = (file: string, text: string): Document => ({ source: 's', file, title: file, text });

/** Фейковый эмбеддер: вектор длины 2 из длины текста (детерминированно). */
const fakeEmbed = async (inputs: string[]): Promise<number[][]> =>
  inputs.map(text => [text.length, 1]);

const baseBuild = {
  chunk: { fixed: { size: 1000, overlap: 0 }, structuralMaxSize: 1000 },
  embed: fakeEmbed,
  model: 'test-embed',
  createdAt: '2026-06-29T00:00:00.000Z',
};

describe('buildIndex', () => {
  it('режет, эмбеддит и собирает записи с метаданными и размерностью', async () => {
    const index = await buildIndex([doc('a.txt', 'привет'), doc('b.txt', 'мир')], {
      ...baseBuild,
      strategy: 'fixed',
    });
    assert.equal(index.strategy, 'fixed');
    assert.equal(index.model, 'test-embed');
    assert.equal(index.dimensions, 2);
    assert.equal(index.chunks.length, 2);
    assert.equal(index.chunks[0].file, 'a.txt');
    assert.deepEqual(index.chunks[0].embedding, ['привет'.length, 1]);
  });

  it('батчинг: маленький batchSize даёт несколько вызовов эмбеддера', async () => {
    let calls = 0;
    const index = await buildIndex(
      [doc('a.txt', 'один'), doc('b.txt', 'два'), doc('c.txt', 'три')],
      {
        ...baseBuild,
        strategy: 'fixed',
        batchSize: 1,
        embed: async inputs => {
          calls++;
          return inputs.map(() => [1, 1]);
        },
      },
    );
    assert.equal(index.chunks.length, 3);
    assert.equal(calls, 3); // по одному вызову на чанк
  });

  it('нет документов → пустой индекс, размерность 0', async () => {
    const index = await buildIndex([], { ...baseBuild, strategy: 'structural' });
    assert.equal(index.chunks.length, 0);
    assert.equal(index.dimensions, 0);
  });
});

describe('JsonIndexStore', () => {
  it('save → load возвращает тот же индекс (создаёт каталоги)', () => {
    const root = mkdtempSync(join(tmpdir(), 'rag-store-'));
    try {
      const path = join(root, 'nested', 'index.json');
      const store = new JsonIndexStore(path);
      const index: Index = {
        strategy: 'fixed',
        model: 'm',
        dimensions: 2,
        createdAt: 't',
        chunks: [
          {
            chunk_id: 'a#0',
            source: 's',
            file: 'a',
            title: 'a',
            section: 'sec',
            text: 'x',
            embedding: [1, 2],
          },
        ],
      };
      store.save(index);
      assert.deepEqual(store.load(), index);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('computeStats', () => {
  const index = (chunks: Index['chunks']): Index => ({
    strategy: 'fixed',
    model: 'm',
    dimensions: 2,
    createdAt: 't',
    chunks,
  });

  it('считает число чанков, размеры и покрытие section', () => {
    const stats = computeStats(
      index([
        {
          chunk_id: '1',
          source: 's',
          file: 'f',
          title: 't',
          section: 'A',
          text: 'abc',
          embedding: [],
        },
        {
          chunk_id: '2',
          source: 's',
          file: 'f',
          title: 't',
          section: '',
          text: 'abcdef',
          embedding: [],
        },
      ]),
    );
    assert.equal(stats.chunkCount, 2);
    assert.equal(stats.minSize, 3);
    assert.equal(stats.maxSize, 6);
    assert.equal(stats.avgSize, 5); // round((3+6)/2)=round(4.5)=5
    assert.equal(stats.withSection, 1); // второй чанк с пустым section не считается
  });

  it('пустой индекс → нули', () => {
    const stats = computeStats(index([]));
    assert.deepEqual(
      [stats.chunkCount, stats.avgSize, stats.minSize, stats.maxSize, stats.withSection],
      [0, 0, 0, 0, 0],
    );
  });
});
