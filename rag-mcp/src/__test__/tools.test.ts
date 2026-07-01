import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleSearchDocs, handleListIndexes, handleBuildIndex, loadRagConfig } from '../index.ts';
import type { ToolDeps } from '../index.ts';
import type { ChunkStrategy, Index, IndexedChunk } from '../../../rag/src/index.ts';

const ch = (id: string, embedding: number[]): IndexedChunk => ({
  chunk_id: id,
  source: 'src',
  file: 'f.md',
  title: 'f.md',
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

/** deps с фейковыми ensure/loadAllCached; embed возвращает [1,0]. */
function makeDeps(over: Partial<ToolDeps> = {}): {
  deps: ToolDeps;
  ensured: { source: string; strategy: ChunkStrategy }[];
} {
  const ensured: { source: string; strategy: ChunkStrategy }[] = [];
  const deps: ToolDeps = {
    config: loadRagConfig({} as NodeJS.ProcessEnv),
    embed: async () => [[1, 0]],
    ensure: async (source, strategy) => {
      ensured.push({ source, strategy });
      return idx([ch('A', [1, 0]), ch('B', [0, 1])]);
    },
    loadAllCached: () => [],
    ...over,
  };
  return { deps, ensured };
}

describe('handleSearchDocs', () => {
  it('пустой query → подсказка', async () => {
    assert.match(await handleSearchDocs(makeDeps().deps, {}), /непустой query/);
  });

  it('с source: индексирует его (стратегия конфига) и ищет', async () => {
    const { deps, ensured } = makeDeps();
    const out = await handleSearchDocs(deps, { query: 'q', source: 'github.com/o/r' });
    assert.deepEqual(ensured, [{ source: 'github.com/o/r', strategy: 'structural' }]);
    assert.match(out, /Найдено фрагментов/);
    assert.match(out, /\[1\] src › f\.md › sec/);
  });

  it('аргумент strategy (fixed/structural) переопределяет стратегию', async () => {
    const fixedDeps = makeDeps();
    await handleSearchDocs(fixedDeps.deps, { query: 'q', source: 's', strategy: 'fixed' });
    assert.equal(fixedDeps.ensured[0].strategy, 'fixed');

    const structuralDeps = makeDeps();
    await handleSearchDocs(structuralDeps.deps, {
      query: 'q',
      source: 's',
      strategy: 'structural',
    });
    assert.equal(structuralDeps.ensured[0].strategy, 'structural');
  });

  it('без source и пустой кэш → подсказка', async () => {
    assert.match(await handleSearchDocs(makeDeps().deps, { query: 'q' }), /пустой кэш/);
  });

  it('без source ищет по кэшированным индексам', async () => {
    const { deps } = makeDeps({ loadAllCached: () => [idx([ch('A', [1, 0])])] });
    assert.match(await handleSearchDocs(deps, { query: 'q' }), /Найдено фрагментов: 1/);
  });

  it('k ограничивает число результатов', async () => {
    const { deps } = makeDeps();
    const out = await handleSearchDocs(deps, { query: 'q', source: 's', k: 1 });
    assert.match(out, /Найдено фрагментов: 1/);
  });

  it('нечисловой/NaN k → дефолт из конфига', async () => {
    const { deps } = makeDeps();
    const out = await handleSearchDocs(deps, { query: 'q', source: 's', k: Number.NaN });
    assert.match(out, /Найдено фрагментов: 2/); // NaN отвергнут numberArg → config.k=5 ≥ 2 чанков
  });

  it('сбой сборки индекса → текст ошибки (Error и не-Error)', async () => {
    const errDeps = makeDeps({
      ensure: async () => {
        throw new Error('репозиторий недоступен');
      },
    });
    assert.match(
      await handleSearchDocs(errDeps.deps, { query: 'q', source: 's' }),
      /репозиторий недоступен/,
    );
    const strDeps = makeDeps({
      ensure: async () => {
        throw 'строковый сбой';
      },
    });
    assert.equal(
      await handleSearchDocs(strDeps.deps, { query: 'q', source: 's' }),
      'строковый сбой',
    );
  });
});

describe('handleListIndexes', () => {
  it('делегирует форматтеру списка', () => {
    const { deps } = makeDeps({ loadAllCached: () => [idx([ch('A', [1, 0])])] });
    assert.match(handleListIndexes(deps), /Индексы \(1\)/);
  });
});

describe('handleBuildIndex', () => {
  it('пустой source → подсказка', async () => {
    assert.match(await handleBuildIndex(makeDeps().deps, {}), /непустой source/);
  });

  it('строит индекс и возвращает сводку (стратегия из аргумента)', async () => {
    const { deps, ensured } = makeDeps();
    const out = await handleBuildIndex(deps, { source: 's', strategy: 'fixed' });
    assert.equal(ensured[0].strategy, 'fixed');
    assert.match(out, /Индекс готов: s \[fixed\] — чанков 2/);
  });

  it('сбой → текст ошибки', async () => {
    const { deps } = makeDeps({
      ensure: async () => {
        throw new Error('нет доступа');
      },
    });
    assert.match(await handleBuildIndex(deps, { source: 's' }), /нет доступа/);
  });
});
