import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isConversationalReply,
  isRecallQuestion,
  isRecallTurn,
  isRecallFallback,
  RECALL_SENTINEL,
  RECALL_SYSTEM_PROMPT,
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

describe('isRecallQuestion', () => {
  it('маркеры воспоминания → true (регистр/пунктуация не мешают)', () => {
    for (const t of [
      'Напомни, каким флагом передать каталог?',
      'повтори последний ответ',
      'с чего начали?',
      'какая у нас задача',
      'что ты называл про экосистемы',
    ]) {
      assert.equal(isRecallQuestion(t), true, `для «${t}»`);
    }
  });

  it('обычный знаниевый вопрос → false', () => {
    for (const t of ['в каком формате вывод?', 'как ограничить экосистемы?']) {
      assert.equal(isRecallQuestion(t), false, `для «${t}»`);
    }
  });
});

describe('isRecallTurn (гибрид)', () => {
  it('LLM-флаг true → true при любом тексте', () => {
    assert.equal(isRecallTurn('в каком формате вывод?', true), true);
  });
  it('LLM-флаг false: решает лексический маркер', () => {
    assert.equal(isRecallTurn('напомни про флаг', false), true);
    assert.equal(isRecallTurn('в каком формате вывод?', false), false);
  });
});

describe('isRecallFallback', () => {
  it('сентинел (в т.ч. обёрнутый/иной регистр) → true; иначе false', () => {
    assert.equal(isRecallFallback(RECALL_SENTINEL), true);
    assert.equal(isRecallFallback(`бла ${RECALL_SENTINEL.toLowerCase()} бла`), true);
    assert.equal(isRecallFallback('Каталог передаётся флагом --exposure-catalog.'), false);
  });
  it('RECALL_SYSTEM_PROMPT велит вернуть сентинел при отсутствии в истории', () => {
    assert.match(RECALL_SYSTEM_PROMPT, new RegExp(RECALL_SENTINEL));
    assert.match(RECALL_SYSTEM_PROMPT, /ДОСЛОВНО/);
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
