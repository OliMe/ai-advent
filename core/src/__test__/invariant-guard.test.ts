import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  enforceInvariants,
  parseInvariantCheck,
  InvariantViolationError,
  Conversation,
} from '../index.ts';
import { clientWith } from './helpers.ts';

/** Фабрика контролёра: каждый вызов отдаёт следующий вердикт из очереди. */
function checkerFactory(t: TestContext, verdicts: string[]): () => Conversation {
  let index = 0;
  return () => {
    const verdict = verdicts[Math.min(index, verdicts.length - 1)];
    index++;
    const client = clientWith(t, async () => ({ content: verdict, usage: undefined }));
    return new Conversation(client, {
      systemPrompt: 'контролёр',
      temperature: 0,
      contextTokens: 8192,
      requestTimeoutMs: 5000,
    });
  };
}

describe('parseInvariantCheck', () => {
  it('ok/нарушения/проза/мусор', () => {
    assert.deepEqual(parseInvariantCheck('{"ok":true}'), []);
    assert.deepEqual(parseInvariantCheck('{"ok":false,"violations":["x","y"]}'), ['x', 'y']);
    assert.deepEqual(parseInvariantCheck('{"ok":false,"violations":["v",1,null]}'), ['v']); // не-строки отброшены
    assert.deepEqual(parseInvariantCheck('{"ok":false}'), []); // нет violations
    assert.deepEqual(parseInvariantCheck('{"ok":false,"violations":"нет"}'), []); // не массив
    assert.deepEqual(parseInvariantCheck('шум {"ok":false,"violations":["z"]} хвост'), ['z']);
    assert.deepEqual(parseInvariantCheck('{сломан}'), []); // похоже на объект, но не парсится
    assert.deepEqual(parseInvariantCheck('не json'), []); // неразобрано → не блокируем
  });
});

describe('enforceInvariants', () => {
  it('без инвариантов — контролёр не вызывается', async t => {
    const text = await enforceInvariants({
      invariants: [],
      makeChecker: () => {
        throw new Error('контролёр не должен вызываться');
      },
      produce: async () => 'РЕЗУЛЬТАТ',
    });
    assert.equal(text, 'РЕЗУЛЬТАТ');
  });

  it('чисто с первого раза — один produce', async t => {
    let calls = 0;
    const text = await enforceInvariants({
      invariants: ['нативный TS'],
      makeChecker: checkerFactory(t, ['{"ok":true}']),
      produce: async () => {
        calls++;
        return 'ОК';
      },
    });
    assert.equal(text, 'ОК');
    assert.equal(calls, 1);
  });

  it('нарушение → перегенерация → успех; фидбэк сохраняет формат', async t => {
    const violations: string[][] = [];
    let feedbackSeen = '';
    const text = await enforceInvariants({
      invariants: ['нативный TS'],
      makeChecker: checkerFactory(t, [
        '{"ok":false,"violations":["webpack запрещён"]}',
        '{"ok":true}',
      ]),
      produce: async feedback => {
        if (feedback !== undefined) feedbackSeen = feedback;
        return feedback === undefined ? 'ПЛОХО' : 'ИСПРАВЛЕНО';
      },
      onViolation: v => violations.push(v),
    });
    assert.equal(text, 'ИСПРАВЛЕНО');
    assert.deepEqual(violations, [['webpack запрещён']]); // одно замечание, перегенерация
    assert.match(feedbackSeen, /webpack запрещён/); // названо нарушение
    assert.match(feedbackSeen, /Сохрани тот же формат/); // напоминание про формат
  });

  it('исчерпание перегенераций → InvariantViolationError', async t => {
    await assert.rejects(
      enforceInvariants({
        invariants: ['нативный TS'],
        makeChecker: checkerFactory(t, ['{"ok":false,"violations":["webpack запрещён"]}']),
        produce: async () => 'ПЛОХО',
        maxRegenerations: 1,
      }),
      (error: unknown) =>
        error instanceof InvariantViolationError &&
        error.violations.join() === 'webpack запрещён' &&
        /Нарушены инварианты/.test(error.message),
    );
  });
});
