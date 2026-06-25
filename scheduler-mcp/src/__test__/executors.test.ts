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

describe('makeExecutors — system_metrics', () => {
  const systemReaders = {
    totalMemoryBytes: () => 1000,
    freeMemoryBytes: () => 500,
    loadAverage1m: () => 1,
    cpuCount: () => 2,
    diskFreePercent: () => 80,
  };

  it('без url — только метрики системы', async () => {
    const executors = makeExecutors({
      fetchFn: async () => ({ status: 200, ok: true }),
      now: () => 0,
      systemReaders,
    });
    const outcome = await executors.system_metrics(task({ kind: 'system_metrics' }));
    assert.equal(outcome.ok, true);
    assert.equal(outcome.details.memoryUsedPercent, 50);
    assert.equal(outcome.details.available, undefined);
  });

  it('с url — доступность и латентность (ok)', async () => {
    const executors = makeExecutors({
      fetchFn: async () => ({ status: 200, ok: true }),
      now: sequenceClock([0, 40]),
      systemReaders,
    });
    const outcome = await executors.system_metrics(
      task({ kind: 'system_metrics', url: 'https://e/' }),
    );
    assert.equal(outcome.details.available, true);
    assert.equal(outcome.details.latencyMs, 40);
    assert.match(outcome.summary, /https:\/\/e\/ ok/);
  });

  it('с url — ответ не ok → down', async () => {
    const executors = makeExecutors({
      fetchFn: async () => ({ status: 500, ok: false }),
      now: sequenceClock([0, 5]),
      systemReaders,
    });
    const outcome = await executors.system_metrics(
      task({ kind: 'system_metrics', url: 'https://e/' }),
    );
    assert.equal(outcome.details.available, false);
    assert.match(outcome.summary, /https:\/\/e\/ down/);
  });

  it('с url — ошибка сети → недоступен', async () => {
    const executors = makeExecutors({
      fetchFn: async () => {
        throw new Error('сбой');
      },
      now: sequenceClock([0, 5]),
      systemReaders,
    });
    const outcome = await executors.system_metrics(
      task({ kind: 'system_metrics', url: 'https://e/' }),
    );
    assert.equal(outcome.details.available, false);
    assert.equal(outcome.details.error, 'сбой');
    assert.match(outcome.summary, /недоступен/);
  });

  it('без systemReaders → сообщает, что сбор не настроен', async () => {
    const executors = makeExecutors({
      fetchFn: async () => ({ status: 200, ok: true }),
      now: () => 0,
    });
    const outcome = await executors.system_metrics(task({ kind: 'system_metrics' }));
    assert.equal(outcome.ok, false);
    assert.match(outcome.summary, /не настроен/);
  });

  it('metricsUrl: число requests попадает в details', async () => {
    const executors = makeExecutors({
      fetchFn: async () => ({ status: 200, ok: true, json: async () => ({ requests: 7 }) }),
      now: () => 0,
      systemReaders,
    });
    const outcome = await executors.system_metrics(
      task({ kind: 'system_metrics', metricsUrl: 'https://e/metrics' }),
    );
    assert.equal(outcome.details.requests, 7);
  });

  it('metricsUrl: нечисловой requests игнорируется', async () => {
    const executors = makeExecutors({
      fetchFn: async () => ({ status: 200, ok: true, json: async () => ({ requests: 'x' }) }),
      now: () => 0,
      systemReaders,
    });
    const outcome = await executors.system_metrics(
      task({ kind: 'system_metrics', metricsUrl: 'https://e/metrics' }),
    );
    assert.equal(outcome.details.requests, undefined);
  });

  it('metricsUrl: ответ без json → без requests', async () => {
    const executors = makeExecutors({
      fetchFn: async () => ({ status: 200, ok: true }),
      now: () => 0,
      systemReaders,
    });
    const outcome = await executors.system_metrics(
      task({ kind: 'system_metrics', metricsUrl: 'https://e/metrics' }),
    );
    assert.equal(outcome.details.requests, undefined);
  });

  it('metricsUrl: ошибка запроса проглатывается', async () => {
    const executors = makeExecutors({
      fetchFn: async () => {
        throw new Error('нет связи');
      },
      now: () => 0,
      systemReaders,
    });
    const outcome = await executors.system_metrics(
      task({ kind: 'system_metrics', metricsUrl: 'https://e/metrics' }),
    );
    assert.equal(outcome.ok, true);
    assert.equal(outcome.details.requests, undefined);
  });
});

describe('makeExecutors — report', () => {
  const metricRun = (memoryUsedPercent: number): import('../index.ts').TaskRun => ({
    id: 'r',
    taskId: 'target',
    taskTitle: 'Метрики',
    firedAt: '2026-01-01T00:00:00.000Z',
    ok: true,
    summary: '',
    details: { memoryUsedPercent },
  });

  it('агрегирует историю целевой задачи', async () => {
    const executors = makeExecutors({
      fetchFn: async () => ({ status: 200, ok: true }),
      now: () => 0,
      history: id => (id === 'target' ? [metricRun(60), metricRun(70)] : []),
    });
    const outcome = await executors.report(task({ kind: 'report', targetTaskId: 'target' }));
    assert.match(String(outcome.details.text), /пик памяти: 70%/);
    assert.match(outcome.summary, /2 замер/);
  });

  it('без history → пустой отчёт', async () => {
    const executors = makeExecutors({
      fetchFn: async () => ({ status: 200, ok: true }),
      now: () => 0,
    });
    const outcome = await executors.report(task({ kind: 'report', targetTaskId: 'x' }));
    assert.match(String(outcome.details.text), /Данных для отчёта пока нет/);
  });

  it('без targetTaskId → запрашивает историю по пустому id', async () => {
    let requested: string | null = null;
    const executors = makeExecutors({
      fetchFn: async () => ({ status: 200, ok: true }),
      now: () => 0,
      history: id => {
        requested = id;
        return [];
      },
    });
    await executors.report(task({ kind: 'report' }));
    assert.equal(requested, '');
  });
});

describe('makeExecutors — digest', () => {
  it('собирает дайджест из активных note-задач', async () => {
    const executors = makeExecutors({
      fetchFn: async () => ({ status: 200, ok: true }),
      now: () => 0,
      activeTasks: () => [task({ kind: 'note', text: 'позвонить маме' })],
    });
    const outcome = await executors.digest(task({ kind: 'digest' }));
    assert.equal(outcome.ok, true);
    assert.match(String(outcome.details.text), /позвонить маме/);
  });

  it('без activeTasks → пустой дайджест', async () => {
    const executors = makeExecutors({
      fetchFn: async () => ({ status: 200, ok: true }),
      now: () => 0,
    });
    const outcome = await executors.digest(task({ kind: 'digest' }));
    assert.match(String(outcome.details.text), /Незакрытых обещаний нет/);
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
