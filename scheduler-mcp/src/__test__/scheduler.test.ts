import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeScheduler, memoryStore, fixedClock, counterIds, trivialExecutors } from './helpers.ts';
import type { SchedulerState } from '../index.ts';

describe('Scheduler.scheduleTask', () => {
  it('создаёт interval-задачу со следующим запуском', () => {
    const clock = fixedClock(1_000);
    const scheduler = makeScheduler({ now: clock.now, idFactory: counterIds('t') });
    const task = scheduler.scheduleTask({
      title: 'пинг',
      kind: 'http_check',
      url: 'https://e/',
      schedule: { type: 'interval', everySeconds: 10 },
    });
    assert.equal(task.id, 't1');
    assert.equal(task.status, 'active');
    assert.equal(task.url, 'https://e/');
    assert.equal(task.nextFireAt, new Date(11_000).toISOString());
  });

  it('создаёт note-задачу (text сохраняется, url отсутствует)', () => {
    const scheduler = makeScheduler();
    const task = scheduler.scheduleTask({
      title: 'напоминание',
      kind: 'note',
      text: 'позвонить',
      schedule: { type: 'once', atIso: '2026-06-25T08:00:00.000Z' },
    });
    assert.equal(task.text, 'позвонить');
    assert.equal(task.url, undefined);
  });

  it('отвергает http_check без url и note без text', () => {
    const scheduler = makeScheduler();
    assert.throws(
      () =>
        scheduler.scheduleTask({
          title: 'x',
          kind: 'http_check',
          schedule: { type: 'interval', everySeconds: 5 },
        }),
      /http_check нужен непустой url/,
    );
    assert.throws(
      () =>
        scheduler.scheduleTask({
          title: 'x',
          kind: 'note',
          schedule: { type: 'interval', everySeconds: 5 },
        }),
      /note нужен непустой text/,
    );
  });

  it('отвергает некорректное расписание', () => {
    const scheduler = makeScheduler();
    assert.throws(
      () =>
        scheduler.scheduleTask({
          title: 'x',
          kind: 'note',
          text: 'y',
          schedule: { type: 'interval', everySeconds: 0 },
        }),
      /everySeconds/,
    );
  });
});

describe('Scheduler — список и поиск', () => {
  it('конструктор читает состояние из хранилища', () => {
    const initial: SchedulerState = {
      tasks: [
        {
          id: 'pre',
          title: 'ранее',
          kind: 'note',
          text: 't',
          deliver: 'inbox',
          schedule: { type: 'interval', everySeconds: 10 },
          status: 'active',
          createdAt: '2026-06-25T00:00:00.000Z',
          nextFireAt: '2026-06-25T00:00:10.000Z',
        },
      ],
      runs: [],
    };
    const scheduler = makeScheduler({ store: memoryStore(initial).store });
    assert.equal(scheduler.listTasks().length, 1);
    assert.equal(scheduler.getTask('pre')?.task.title, 'ранее');
  });

  it('getTask для несуществующей задачи → null', () => {
    assert.equal(makeScheduler().getTask('нет'), null);
  });
});

describe('Scheduler.tick', () => {
  function intervalScheduler() {
    const clock = fixedClock(1_000);
    const scheduler = makeScheduler({ now: clock.now, idFactory: counterIds() });
    const task = scheduler.scheduleTask({
      title: 'пинг',
      kind: 'http_check',
      url: 'https://e/',
      schedule: { type: 'interval', everySeconds: 10 },
    });
    return { scheduler, clock, task };
  }

  it('не запускает задачу раньше времени (и не пишет)', async () => {
    const { scheduler } = intervalScheduler();
    const fired = await scheduler.tick(); // clock=1000, nextFire=11000
    assert.equal(fired.length, 0);
    assert.equal(scheduler.listTasks()[0].lastRunAt, undefined);
  });

  it('запускает созревшую interval-задачу и переносит следующий запуск', async () => {
    const { scheduler, clock } = intervalScheduler();
    clock.set(11_000);
    const fired = await scheduler.tick();
    assert.equal(fired.length, 1);
    const task = scheduler.listTasks()[0];
    assert.equal(task.status, 'active');
    assert.equal(task.lastRunAt, new Date(11_000).toISOString());
    assert.equal(task.nextFireAt, new Date(21_000).toISOString());
  });

  it('once-задача после срабатывания завершается', async () => {
    const clock = fixedClock(1_000);
    const scheduler = makeScheduler({ now: clock.now });
    scheduler.scheduleTask({
      title: 'разово',
      kind: 'note',
      text: 'привет',
      schedule: { type: 'once', atIso: new Date(5_000).toISOString() },
    });
    clock.set(5_000);
    await scheduler.tick();
    const task = scheduler.listTasks()[0];
    assert.equal(task.status, 'completed');
    assert.equal(task.nextFireAt, null);
  });

  it('daily-задача переносится на следующий день', async () => {
    const clock = fixedClock(Date.UTC(2026, 0, 1, 0, 0, 0));
    const scheduler = makeScheduler({ now: clock.now });
    const created = scheduler.scheduleTask({
      title: 'утро',
      kind: 'note',
      text: 'доброе утро',
      schedule: { type: 'daily', at: '08:00', tzOffsetMinutes: 0 },
    });
    const firstFire = created.nextFireAt!; // строка — снимок до мутации
    clock.set(Date.parse(firstFire));
    await scheduler.tick();
    const task = scheduler.listTasks()[0];
    assert.equal(task.status, 'active');
    assert.ok(Date.parse(task.nextFireAt!) > Date.parse(firstFire));
  });

  it('пропускает задачу на паузе', async () => {
    const { scheduler, clock, task } = intervalScheduler();
    scheduler.pauseTask(task.id);
    clock.set(11_000);
    const fired = await scheduler.tick();
    assert.equal(fired.length, 0);
  });
});

describe('Scheduler — управление', () => {
  it('runNow выполняет немедленно, не трогая расписание', async () => {
    const clock = fixedClock(1_000);
    const scheduler = makeScheduler({ now: clock.now, idFactory: counterIds() });
    const task = scheduler.scheduleTask({
      title: 'пинг',
      kind: 'http_check',
      url: 'https://e/',
      schedule: { type: 'interval', everySeconds: 10 },
    });
    const before = task.nextFireAt;
    clock.set(2_000);
    const run = await scheduler.runNow(task.id);
    assert.ok(run !== null);
    assert.equal(scheduler.listTasks()[0].nextFireAt, before); // расписание не сдвинулось
    assert.equal(scheduler.listTasks()[0].lastRunAt, new Date(2_000).toISOString());
  });

  it('runNow для несуществующей задачи → null', async () => {
    assert.equal(await makeScheduler().runNow('нет'), null);
  });

  it('cancelTask удаляет, повтор — false', () => {
    const scheduler = makeScheduler();
    const task = scheduler.scheduleTask({
      title: 'x',
      kind: 'note',
      text: 'y',
      schedule: { type: 'interval', everySeconds: 5 },
    });
    assert.equal(scheduler.cancelTask(task.id), true);
    assert.equal(scheduler.listTasks().length, 0);
    assert.equal(scheduler.cancelTask(task.id), false);
  });

  it('pause/resume: найдено/не найдено; resume пересчитывает запуск', () => {
    const clock = fixedClock(1_000);
    const scheduler = makeScheduler({ now: clock.now });
    const task = scheduler.scheduleTask({
      title: 'x',
      kind: 'note',
      text: 'y',
      schedule: { type: 'interval', everySeconds: 10 },
    });
    assert.equal(scheduler.pauseTask(task.id), true);
    assert.equal(scheduler.listTasks()[0].status, 'paused');
    clock.set(5_000);
    assert.equal(scheduler.resumeTask(task.id), true);
    assert.equal(scheduler.listTasks()[0].status, 'active');
    assert.equal(scheduler.listTasks()[0].nextFireAt, new Date(15_000).toISOString());
    assert.equal(scheduler.pauseTask('нет'), false);
    assert.equal(scheduler.resumeTask('нет'), false);
  });
});

describe('Scheduler.getHistory', () => {
  it('новые первыми, фильтр по задаче, лимит и пустота', async () => {
    const scheduler = makeScheduler({ idFactory: counterIds() });
    const a = scheduler.scheduleTask({
      title: 'A',
      kind: 'note',
      text: 'a',
      schedule: { type: 'interval', everySeconds: 5 },
    });
    const b = scheduler.scheduleTask({
      title: 'B',
      kind: 'note',
      text: 'b',
      schedule: { type: 'interval', everySeconds: 5 },
    });
    await scheduler.runNow(a.id);
    await scheduler.runNow(b.id);
    const all = scheduler.getHistory();
    assert.equal(all.length, 2);
    assert.equal(all[0].taskId, b.id); // новые первыми
    assert.equal(scheduler.getHistory({ taskId: a.id }).length, 1);
    assert.equal(scheduler.getHistory({ limit: 1 }).length, 1);
    assert.deepEqual(scheduler.getHistory({ taskId: 'нет' }), []);
  });

  it('история на задачу ограничена потолком', async () => {
    const scheduler = makeScheduler({ idFactory: counterIds() });
    const task = scheduler.scheduleTask({
      title: 'A',
      kind: 'note',
      text: 'a',
      schedule: { type: 'interval', everySeconds: 5 },
    });
    for (let index = 0; index < 201; index++) {
      await scheduler.runNow(task.id);
    }
    assert.equal(scheduler.getHistory({ taskId: task.id, limit: 1000 }).length, 200);
  });

  it('pollResults: все или только новее курсора', async () => {
    const clock = fixedClock(1_000);
    const scheduler = makeScheduler({ now: clock.now, idFactory: counterIds() });
    const task = scheduler.scheduleTask({
      title: 'A',
      kind: 'note',
      text: 'a',
      schedule: { type: 'interval', everySeconds: 5 },
    });
    await scheduler.runNow(task.id); // firedAt = iso(1000)
    clock.set(2_000);
    await scheduler.runNow(task.id); // firedAt = iso(2000)
    assert.equal(scheduler.pollResults().length, 2);
    const newer = scheduler.pollResults(new Date(1_000).toISOString());
    assert.equal(newer.length, 1);
    assert.equal(newer[0].firedAt, new Date(2_000).toISOString());
  });
});

describe('Scheduler — доставка и agent', () => {
  it('после запуска вызывает доставку с результатом и задачей', async () => {
    const calls: { taskId: string; deliver: string }[] = [];
    const scheduler = makeScheduler({
      deliver: async (run, task) => {
        calls.push({ taskId: run.taskId, deliver: task.deliver });
      },
    });
    const task = scheduler.scheduleTask({
      title: 'A',
      kind: 'note',
      text: 'a',
      deliver: 'telegram',
      schedule: { type: 'interval', everySeconds: 5 },
    });
    await scheduler.runNow(task.id);
    assert.deepEqual(calls, [{ taskId: task.id, deliver: 'telegram' }]);
  });

  it('agent: требует instruction; создаётся с instruction и каналом', () => {
    const scheduler = makeScheduler();
    assert.throws(
      () =>
        scheduler.scheduleTask({
          title: 'x',
          kind: 'agent',
          schedule: { type: 'interval', everySeconds: 5 },
        }),
      /agent нужна непустая instruction/,
    );
    const task = scheduler.scheduleTask({
      title: 'погода',
      kind: 'agent',
      instruction: 'прогноз и рекомендации',
      deliver: 'telegram',
      schedule: { type: 'daily', at: '08:00', tzOffsetMinutes: 300 },
    });
    assert.equal(task.kind, 'agent');
    assert.equal(task.instruction, 'прогноз и рекомендации');
    assert.equal(task.deliver, 'telegram');
  });

  it('system_metrics с metricsUrl сохраняет его', () => {
    const task = makeScheduler().scheduleTask({
      title: 'Метрики',
      kind: 'system_metrics',
      url: 'https://smartnfree.ru/mcp',
      metricsUrl: 'https://smartnfree.ru/metrics',
      schedule: { type: 'interval', everySeconds: 600 },
    });
    assert.equal(task.metricsUrl, 'https://smartnfree.ru/metrics');
  });

  it('report: требует targetTaskId; создаётся с ним', () => {
    const scheduler = makeScheduler();
    assert.throws(
      () =>
        scheduler.scheduleTask({
          title: 'отчёт',
          kind: 'report',
          schedule: { type: 'interval', everySeconds: 5 },
        }),
      /targetTaskId/,
    );
    const task = scheduler.scheduleTask({
      title: 'отчёт',
      kind: 'report',
      targetTaskId: 'metrics-1',
      schedule: { type: 'daily', at: '09:00', tzOffsetMinutes: 300 },
    });
    assert.equal(task.targetTaskId, 'metrics-1');
  });
});
