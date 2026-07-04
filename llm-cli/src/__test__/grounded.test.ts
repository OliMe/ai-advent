import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isConversationalReply,
  groundedFocus,
  buildGroundedQuery,
  forcedRagSearch,
} from '../index.ts';
import type { Task, ToolSet, ToolSpec } from '../../../core/src/index.ts';

describe('isConversationalReply', () => {
  it('приветствия/благодарности/да-нет/короткие → true', () => {
    for (const t of ['привет', 'Спасибо!', 'да', 'ок', 'Понятно.', '?', 'ага']) {
      assert.equal(isConversationalReply(t), true, `для «${t}»`);
    }
  });

  it('содержательные вопросы → false (в т.ч. «спасибо, а как…»)', () => {
    for (const t of ['как ограничить джобы?', 'спасибо, а как перезапустить?', 'что делает scan']) {
      assert.equal(isConversationalReply(t), false, `для «${t}»`);
    }
  });
});

describe('groundedFocus', () => {
  const task = { title: 'Цель диалога' } as Task;
  it('нет задачи → только инварианты; есть задача → цель + инварианты', () => {
    assert.deepEqual(groundedFocus(null, ['терм А']), ['терм А']);
    assert.deepEqual(groundedFocus(task, ['терм А', 'терм Б']), [
      'Цель диалога',
      'терм А',
      'терм Б',
    ]);
  });
});

describe('buildGroundedQuery', () => {
  it('пустой фокус → запрос как есть', () => {
    assert.equal(buildGroundedQuery('вопрос', []), 'вопрос');
    assert.equal(buildGroundedQuery('вопрос', ['  ']), 'вопрос'); // пустые отфильтрованы
  });
  it('непустой фокус → дописывается контекст', () => {
    assert.equal(
      buildGroundedQuery('вопрос', ['Цель', 'терм']),
      'вопрос\nКонтекст диалога: Цель; терм',
    );
  });
});

describe('forcedRagSearch', () => {
  const spec = (name: string): ToolSpec => ({ name, description: '', parameters: {} });
  const makeToolSet = (names: string[], calls: string[][]): ToolSet =>
    ({
      specs: () => names.map(spec),
      call: async (name: string, args: Record<string, unknown>) => {
        calls.push([name, String(args.source)]);
        return `результат по ${String(args.source)}`;
      },
    }) as unknown as ToolSet;

  it('вызывает search_docs по каждому источнику, собирает результаты, зовёт onSearch', async () => {
    const calls: string[][] = [];
    const seen: string[] = [];
    const results = await forcedRagSearch(
      makeToolSet(['other', 'rag__search_docs'], calls),
      ['/a', '/b'],
      'запрос',
      (name, _args, result) => seen.push(`${name}:${result}`),
    );
    assert.deepEqual(calls, [
      ['rag__search_docs', '/a'],
      ['rag__search_docs', '/b'],
    ]);
    assert.deepEqual(results, ['результат по /a', 'результат по /b']);
    assert.equal(seen.length, 2);
  });

  it('нет инструмента поиска → пустой список (grounded не сработает)', async () => {
    const calls: string[][] = [];
    const results = await forcedRagSearch(makeToolSet(['echo'], calls), ['/a'], 'q');
    assert.deepEqual(results, []);
    assert.deepEqual(calls, []);
  });
});
