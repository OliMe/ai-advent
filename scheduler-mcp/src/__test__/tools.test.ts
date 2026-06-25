import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeSchedule,
  handleScheduleTask,
  handleListTasks,
  handleGetTask,
  handleCancelTask,
  handlePauseTask,
  handleResumeTask,
  handleRunNow,
  handleGetHistory,
  handlePollResults,
} from '../index.ts';
import type { Executor, TaskKind } from '../index.ts';
import { makeScheduler, fixedClock, counterIds } from './helpers.ts';

/** Исполнители с управляемым исходом (http_check — провал, note — успех). */
function executors(): Record<TaskKind, Executor> {
  return {
    http_check: async () => ({ ok: false, summary: 'недоступен', details: {} }),
    note: async task => ({ ok: true, summary: task.text ?? '', details: {} }),
    agent: async task => ({
      ok: true,
      summary: 'Итог',
      details: { text: `Полный ответ: ${task.instruction ?? ''}` },
    }),
  };
}

describe('describeSchedule', () => {
  it('форматирует все три вида и смещения пояса', () => {
    assert.equal(describeSchedule({ type: 'interval', everySeconds: 30 }), 'каждые 30 с');
    assert.equal(
      describeSchedule({ type: 'daily', at: '08:00', tzOffsetMinutes: 300 }),
      'ежедневно в 08:00 (UTC+05:00)',
    );
    assert.equal(
      describeSchedule({ type: 'daily', at: '09:30', tzOffsetMinutes: -330 }),
      'ежедневно в 09:30 (UTC-05:30)',
    );
    assert.equal(
      describeSchedule({ type: 'once', atIso: '2026-06-25T08:00:00.000Z' }),
      'однократно 2026-06-25T08:00:00.000Z',
    );
  });
});

describe('handleScheduleTask', () => {
  it('успех и ошибка валидации', () => {
    const scheduler = makeScheduler({ idFactory: counterIds('t') });
    const ok = handleScheduleTask(scheduler, {
      title: 'пинг',
      kind: 'http_check',
      url: 'https://e/',
      schedule: { type: 'interval', everySeconds: 10 },
    });
    assert.match(ok, /✅ Задача создана: t1/);
    const bad = handleScheduleTask(scheduler, {
      title: 'x',
      kind: 'http_check',
      schedule: { type: 'interval', everySeconds: 10 },
    });
    assert.match(bad, /❌ Не удалось создать задачу: .*url/);
  });

  it('ошибка не-Error приводится к строке', () => {
    const stub = {
      scheduleTask: () => {
        throw 'сбой-строкой';
      },
    } as unknown as Parameters<typeof handleScheduleTask>[0];
    const result = handleScheduleTask(stub, {
      title: 'x',
      kind: 'note',
      text: 'y',
      schedule: { type: 'interval', everySeconds: 5 },
    });
    assert.match(result, /❌.*сбой-строкой/);
  });
});

describe('handleListTasks', () => {
  it('пусто и со списком', () => {
    const scheduler = makeScheduler();
    assert.equal(handleListTasks(scheduler), 'Задач нет.');
    scheduler.scheduleTask({
      title: 'A',
      kind: 'note',
      text: 'a',
      schedule: { type: 'interval', everySeconds: 5 },
    });
    assert.match(handleListTasks(scheduler), /«A» \[note, active\].*каждые 5 с/);
  });
});

describe('handleGetTask', () => {
  it('не найдено / без запусков / с запусками (✓ и ✗)', async () => {
    const scheduler = makeScheduler({ executors: executors(), idFactory: counterIds('t') });
    assert.match(handleGetTask(scheduler, 'нет'), /не найдена/);
    const note = scheduler.scheduleTask({
      title: 'N',
      kind: 'note',
      text: 'привет',
      schedule: { type: 'interval', everySeconds: 5 },
    });
    assert.match(handleGetTask(scheduler, note.id), /запусков ещё не было/);
    await scheduler.runNow(note.id); // ✓
    const check = scheduler.scheduleTask({
      title: 'C',
      kind: 'http_check',
      url: 'https://e/',
      schedule: { type: 'interval', everySeconds: 5 },
    });
    await scheduler.runNow(check.id); // ✗
    assert.match(handleGetTask(scheduler, note.id), /✓ «N»: привет/);
    assert.match(handleGetTask(scheduler, check.id), /✗ «C»: недоступен/);
  });

  it('завершённая once-задача показывает следующий запуск как «—»', async () => {
    const clock = fixedClock(1_000);
    const scheduler = makeScheduler({ now: clock.now });
    const task = scheduler.scheduleTask({
      title: 'O',
      kind: 'note',
      text: 't',
      schedule: { type: 'once', atIso: new Date(2_000).toISOString() },
    });
    clock.set(2_000);
    await scheduler.tick();
    assert.match(handleGetTask(scheduler, task.id), /completed.*след\.: —/s);
  });
});

describe('handleCancelTask / Pause / Resume / RunNow', () => {
  it('найдено и не найдено', async () => {
    const scheduler = makeScheduler({ executors: executors() });
    const task = scheduler.scheduleTask({
      title: 'A',
      kind: 'note',
      text: 'a',
      schedule: { type: 'interval', everySeconds: 5 },
    });
    assert.match(handlePauseTask(scheduler, task.id), /на паузе/);
    assert.match(handleResumeTask(scheduler, task.id), /возобновлена/);
    assert.match(await handleRunNow(scheduler, task.id), /Выполнено: .*✓ «A»: a/);
    assert.match(handleCancelTask(scheduler, task.id), /удалена/);
    assert.match(handlePauseTask(scheduler, 'нет'), /не найдена/);
    assert.match(handleResumeTask(scheduler, 'нет'), /не найдена/);
    assert.match(await handleRunNow(scheduler, 'нет'), /не найдена/);
    assert.match(handleCancelTask(scheduler, 'нет'), /не найдена/);
  });

  it('agent-результат показывает полный текст из details.text', async () => {
    const scheduler = makeScheduler({ executors: executors() });
    const task = scheduler.scheduleTask({
      title: 'Погода',
      kind: 'agent',
      instruction: 'рекомендации',
      schedule: { type: 'interval', everySeconds: 5 },
    });
    assert.match(await handleRunNow(scheduler, task.id), /Полный ответ: рекомендации/);
  });
});

describe('handlePollResults', () => {
  it('возвращает JSON с новыми запусками; text = полный для agent, сводка для прочих', async () => {
    const scheduler = makeScheduler({ executors: executors() });
    const note = scheduler.scheduleTask({
      title: 'N',
      kind: 'note',
      text: 'заметка',
      schedule: { type: 'interval', everySeconds: 5 },
    });
    const agent = scheduler.scheduleTask({
      title: 'A',
      kind: 'agent',
      instruction: 'привет',
      schedule: { type: 'interval', everySeconds: 5 },
    });
    await scheduler.runNow(note.id);
    await scheduler.runNow(agent.id);
    const parsed = JSON.parse(handlePollResults(scheduler, {})) as {
      runs: { taskTitle: string; text: string }[];
    };
    assert.equal(parsed.runs.length, 2);
    const byTitle = Object.fromEntries(parsed.runs.map(run => [run.taskTitle, run.text]));
    assert.equal(byTitle.N, 'заметка'); // нет details.text → сводка
    assert.match(byTitle.A, /Полный ответ: привет/); // есть details.text → полный текст
  });
});

describe('handleGetHistory', () => {
  it('пусто и с записями', async () => {
    const scheduler = makeScheduler({ executors: executors() });
    assert.equal(handleGetHistory(scheduler, {}), 'История пуста.');
    const task = scheduler.scheduleTask({
      title: 'A',
      kind: 'note',
      text: 'a',
      schedule: { type: 'interval', everySeconds: 5 },
    });
    await scheduler.runNow(task.id);
    assert.match(handleGetHistory(scheduler, { taskId: task.id }), /✓ «A»: a/);
  });
});
