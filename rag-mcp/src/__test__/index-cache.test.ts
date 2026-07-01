import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ensureIndex } from '../index.ts';
import type { CacheDeps } from '../index.ts';
import type { Index } from '../../../rag/src/index.ts';

const index = (tag: string): Index => ({
  strategy: 'structural',
  model: 'm',
  dimensions: 2,
  createdAt: tag,
  chunks: [],
});

describe('ensureIndex', () => {
  it('кэш-хит: берёт из кэша, не строит', async () => {
    const calls: string[] = [];
    const deps: CacheDeps = {
      has: () => true,
      load: () => {
        calls.push('load');
        return index('cached');
      },
      build: async () => {
        calls.push('build');
        return index('built');
      },
      save: () => calls.push('save'),
    };
    const result = await ensureIndex('src', 'structural', deps);
    assert.equal(result.createdAt, 'cached');
    assert.deepEqual(calls, ['load']); // build/save не вызывались
  });

  it('кэш-мисс: строит на лету и сохраняет', async () => {
    const calls: string[] = [];
    let savedKey = '';
    const deps: CacheDeps = {
      has: () => false,
      load: () => index('cached'),
      build: async () => {
        calls.push('build');
        return index('built');
      },
      save: key => {
        savedKey = key;
        calls.push('save');
      },
    };
    const result = await ensureIndex('src', 'fixed', deps);
    assert.equal(result.createdAt, 'built');
    assert.deepEqual(calls, ['build', 'save']);
    assert.ok(savedKey.length > 0); // сохранён под ключом
  });
});
