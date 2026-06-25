import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeExecutors } from '../index.ts';
import type { FetchLike, Task } from '../index.ts';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    title: 'тест',
    kind: 'http_check',
    schedule: { type: 'interval', everySeconds: 10 },
    status: 'active',
    createdAt: '2026-06-25T00:00:00.000Z',
    nextFireAt: null,
    ...overrides,
  };
}

/** Часы, выдающие значения по очереди (для замера латентности). */
function sequenceClock(values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

describe('makeExecutors — http_check', () => {
  it('доступен: статус, ok и латентность', async () => {
    const fetchFn: FetchLike = async () => ({ status: 200, ok: true });
    const executors = makeExecutors({ fetchFn, now: sequenceClock([1000, 1300]) });
    const outcome = await executors.http_check(task({ url: 'https://e/' }));
    assert.equal(outcome.ok, true);
    assert.match(outcome.summary, /HTTP 200 за 300 мс/);
    assert.deepEqual(outcome.details, { status: 200, ok: true, latencyMs: 300 });
  });

  it('без url пингует пустую строку (status berётся как есть)', async () => {
    let requested = 'нетронуто';
    const fetchFn: FetchLike = async url => {
      requested = url;
      return { status: 500, ok: false };
    };
    const executors = makeExecutors({ fetchFn, now: sequenceClock([0, 5]) });
    const outcome = await executors.http_check(task());
    assert.equal(requested, '');
    assert.equal(outcome.ok, false);
  });

  it('ошибка сети (Error): недоступен', async () => {
    const fetchFn: FetchLike = async () => {
      throw new Error('таймаут');
    };
    const executors = makeExecutors({ fetchFn, now: sequenceClock([10, 25]) });
    const outcome = await executors.http_check(task({ url: 'https://e/' }));
    assert.equal(outcome.ok, false);
    assert.match(outcome.summary, /недоступен: таймаут/);
    assert.deepEqual(outcome.details, { error: 'таймаут', latencyMs: 15 });
  });

  it('ошибка не-Error: приводится к строке', async () => {
    const fetchFn: FetchLike = async () => {
      throw 'строковый сбой';
    };
    const executors = makeExecutors({ fetchFn, now: sequenceClock([0, 0]) });
    const outcome = await executors.http_check(task({ url: 'https://e/' }));
    assert.match(outcome.summary, /недоступен: строковый сбой/);
  });
});

describe('makeExecutors — note', () => {
  it('возвращает свой текст', async () => {
    const executors = makeExecutors({
      fetchFn: async () => ({ status: 200, ok: true }),
      now: () => 0,
    });
    assert.deepEqual(await executors.note(task({ kind: 'note', text: 'купить хлеб' })), {
      ok: true,
      summary: 'купить хлеб',
      details: {},
    });
  });

  it('без текста — пустая строка', async () => {
    const executors = makeExecutors({
      fetchFn: async () => ({ status: 200, ok: true }),
      now: () => 0,
    });
    assert.equal((await executors.note(task({ kind: 'note' }))).summary, '');
  });
});
