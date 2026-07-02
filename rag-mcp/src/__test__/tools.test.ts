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
    config: loadRagConfig({ RAG_RERANK: 'none' } as NodeJS.ProcessEnv),
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

  it('печатает трассу «до/после» (кандидаты → rerank → итог)', async () => {
    const { deps } = makeDeps();
    const out = await handleSearchDocs(deps, { query: 'q', source: 's' });
    assert.match(out, /🔎 кандидатов 2 → rerank\(none\): 2/);
  });

  it('аргумент rerank переопределяет режim (mmr в трассе)', async () => {
    const { deps } = makeDeps();
    const out = await handleSearchDocs(deps, { query: 'q', source: 's', rerank: 'mmr' });
    assert.match(out, /rerank\(mmr\)/);
  });

  it('аргумент minScore отсекает слабые (видно в трассе)', async () => {
    const { deps } = makeDeps();
    const out = await handleSearchDocs(deps, { query: 'q', source: 's', minScore: 0.5 });
    // B(cos=0) отсечён порогом 0.5: из 2 кандидатов остаётся 1.
    assert.match(out, /порог≥0\.50: 1/);
    assert.match(out, /Найдено фрагментов: 1/);
  });

  it('rewrite=expand с chat-моделью переписывает запрос (пометка в трассе)', async () => {
    const calls: string[] = [];
    const chatComplete = async (system: string) => {
      calls.push(system);
      return 'синонимы';
    };
    const { deps } = makeDeps({ chatComplete });
    const out = await handleSearchDocs(deps, { query: 'q', source: 's', rewrite: 'expand' });
    assert.match(out, /запрос переписан/);
    assert.equal(calls.length, 1); // модель вызвана для переписывания
  });

  it('rerank=llm с chat-моделью реранжирует (llm в трассе)', async () => {
    const chatComplete = async () => '[0.9, 0.1]';
    const { deps } = makeDeps({ chatComplete });
    const out = await handleSearchDocs(deps, { query: 'q', source: 's', rerank: 'llm' });
    assert.match(out, /rerank\(llm\)/);
  });

  it('rerank=llm без chat-модели деградирует до none', async () => {
    const { deps } = makeDeps(); // без chatComplete
    const out = await handleSearchDocs(deps, { query: 'q', source: 's', rerank: 'llm' });
    assert.match(out, /rerank\(none\)/);
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
