import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FilteredToolSet, serverScopePredicate, scopePipelineTools } from '../filtered-tool-set.ts';
import type { ToolSet, ToolSpec } from '../../../core/src/index.ts';

/** Фейковый набор: инструменты по именам, `call` возвращает `выполнено:<имя>` и фиксирует вызовы. */
function fakeToolSet(names: string[], calls?: string[]): ToolSet {
  return {
    specs: (): ToolSpec[] =>
      names.map(name => ({ name, description: name, parameters: { type: 'object' } })),
    call: async (name: string) => {
      calls?.push(name);
      return `выполнено:${name}`;
    },
  };
}

describe('serverScopePredicate', () => {
  it('пропускает инструменты разрешённых серверов по неймспейсу, прочие — нет', () => {
    const allow = serverScopePredicate(['git', 'rag']);
    assert.equal(allow('git__read_file'), true);
    assert.equal(allow('rag__search_docs'), true);
    assert.equal(allow('scheduler__schedule_task'), false);
    assert.equal(allow('get_my_location'), false); // без неймспейса → сервер '' не в списке
  });
});

describe('FilteredToolSet', () => {
  it('specs показывает только разрешённые инструменты', () => {
    const inner = fakeToolSet(['git__read_file', 'scheduler__schedule_task', 'rag__search_docs']);
    const filtered = new FilteredToolSet(inner, serverScopePredicate(['git', 'rag']));
    assert.deepEqual(
      filtered.specs().map(spec => spec.name),
      ['git__read_file', 'rag__search_docs'], // scheduler скрыт
    );
  });

  it('call разрешённого делегирует, запрещённого — отказ без делегирования', async () => {
    const calls: string[] = [];
    const inner = fakeToolSet(['git__read_file', 'scheduler__schedule_task'], calls);
    const filtered = new FilteredToolSet(inner, serverScopePredicate(['git']));
    assert.equal(await filtered.call('git__read_file', {}), 'выполнено:git__read_file');
    assert.match(await filtered.call('scheduler__schedule_task', {}), /недоступен на этом этапе/);
    assert.deepEqual(calls, ['git__read_file']); // запрещённый инструмент не исполнялся
  });
});

describe('scopePipelineTools', () => {
  const inner = fakeToolSet(['git__read_file', 'scheduler__schedule_task']);

  it('нет инструментов → undefined', () => {
    assert.equal(scopePipelineTools(null, ['git']), undefined);
    assert.equal(scopePipelineTools(undefined, ['git']), undefined);
  });

  it('список серверов не задан/пуст → исходный набор без изменений', () => {
    assert.equal(scopePipelineTools(inner, undefined), inner); // та же ссылка
    assert.equal(scopePipelineTools(inner, []), inner);
  });

  it('список серверов задан → отфильтрованный набор', () => {
    const scoped = scopePipelineTools(inner, ['git']);
    assert.ok(scoped instanceof FilteredToolSet);
    assert.deepEqual(
      scoped!.specs().map(spec => spec.name),
      ['git__read_file'],
    );
  });
});
