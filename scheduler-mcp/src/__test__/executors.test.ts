import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeExecutors } from '../index.ts';
import type { FetchLike, Task } from '../index.ts';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    title: 'тест',
    kind: 'http_check',
    deliver: 'inbox',
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

describe('makeExecutors — agent', () => {
  const baseDeps = {
    fetchFn: (async () => ({ status: 200, ok: true })) as FetchLike,
    now: () => 0,
  };

  it('с раннером: успех — первая строка в summary, полный текст в details', async () => {
    let received = 'нетронуто';
    const executors = makeExecutors({
      ...baseDeps,
      agentRunner: {
        run: async instruction => {
          received = instruction;
          return 'Рекомендация\nподробности';
        },
      },
    });
    const outcome = await executors.agent(task({ kind: 'agent', instruction: 'одеться?' }));
    assert.equal(received, 'одеться?');
    assert.equal(outcome.ok, true);
    assert.equal(outcome.summary, 'Рекомендация');
    assert.equal(outcome.details.text, 'Рекомендация\nподробности');
  });

  it('без instruction раннер получает пустую строку', async () => {
    let received = 'нетронуто';
    const executors = makeExecutors({
      ...baseDeps,
      agentRunner: {
        run: async instruction => {
          received = instruction;
          return 'ок';
        },
      },
    });
    await executors.agent(task({ kind: 'agent' }));
    assert.equal(received, '');
  });

  it('раннер бросил → ok:false с текстом ошибки', async () => {
    const executors = makeExecutors({
      ...baseDeps,
      agentRunner: {
        run: async () => {
          throw new Error('модель упала');
        },
      },
    });
    const outcome = await executors.agent(task({ kind: 'agent', instruction: 'x' }));
    assert.equal(outcome.ok, false);
    assert.match(outcome.summary, /ошибка исполнения: модель упала/);
    assert.equal(outcome.details.error, 'модель упала');
  });

  it('без раннера → сообщает, что LLM не настроен', async () => {
    const executors = makeExecutors(baseDeps);
    const outcome = await executors.agent(task({ kind: 'agent', instruction: 'x' }));
    assert.equal(outcome.ok, false);
    assert.match(outcome.summary, /LLM-исполнитель не настроен/);
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
