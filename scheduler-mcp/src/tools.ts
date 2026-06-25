import type { Schedule, Task, TaskRun } from './types.ts';
import type { Scheduler, ScheduleTaskInput } from './scheduler.ts';

/** Форматирует смещение пояса в минутах как ±HH:MM. */
function formatOffset(tzOffsetMinutes: number): string {
  const sign = tzOffsetMinutes < 0 ? '-' : '+';
  const absolute = Math.abs(tzOffsetMinutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, '0');
  const minutes = String(absolute % 60).padStart(2, '0');
  return `${sign}${hours}:${minutes}`;
}

/** Человекочитаемое описание расписания. */
export function describeSchedule(schedule: Schedule): string {
  if (schedule.type === 'interval') {
    return `каждые ${schedule.everySeconds} с`;
  }
  if (schedule.type === 'daily') {
    return `ежедневно в ${schedule.at} (UTC${formatOffset(schedule.tzOffsetMinutes)})`;
  }
  return `однократно ${schedule.atIso}`;
}

/** Однострочное описание задачи. */
function describeTask(task: Task): string {
  const next = task.nextFireAt ?? '—';
  return `${task.id} «${task.title}» [${task.kind}, ${task.status}] ${describeSchedule(task.schedule)}; след.: ${next}`;
}

/** Описание запуска: полный текст (для agent — в details.text), иначе краткая сводка. */
function describeRun(run: TaskRun): string {
  const body = typeof run.details.text === 'string' ? run.details.text : run.summary;
  return `${run.firedAt} ${run.ok ? '✓' : '✗'} «${run.taskTitle}»: ${body}`;
}

/** Создаёт задачу; при ошибке валидации возвращает текст ошибки (агент его передаст). */
export function handleScheduleTask(scheduler: Scheduler, input: ScheduleTaskInput): string {
  try {
    const task = scheduler.scheduleTask(input);
    return `✅ Задача создана: ${describeTask(task)}`;
  } catch (error) {
    return `❌ Не удалось создать задачу: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** Список всех задач. */
export function handleListTasks(scheduler: Scheduler): string {
  const tasks = scheduler.listTasks();
  if (tasks.length === 0) {
    return 'Задач нет.';
  }
  return tasks.map(describeTask).join('\n');
}

/** Подробности задачи с последними запусками. */
export function handleGetTask(scheduler: Scheduler, id: string): string {
  const found = scheduler.getTask(id);
  if (found === null) {
    return `Задача не найдена: ${id}`;
  }
  const recent = [...found.runs].reverse().slice(0, 5);
  const history = recent.length === 0 ? 'запусков ещё не было' : recent.map(describeRun).join('\n');
  return `${describeTask(found.task)}\nПоследние запуски:\n${history}`;
}

/** Удаляет задачу. */
export function handleCancelTask(scheduler: Scheduler, id: string): string {
  return scheduler.cancelTask(id) ? `Задача удалена: ${id}` : `Задача не найдена: ${id}`;
}

/** Ставит задачу на паузу. */
export function handlePauseTask(scheduler: Scheduler, id: string): string {
  return scheduler.pauseTask(id) ? `Задача на паузе: ${id}` : `Задача не найдена: ${id}`;
}

/** Снимает задачу с паузы. */
export function handleResumeTask(scheduler: Scheduler, id: string): string {
  return scheduler.resumeTask(id) ? `Задача возобновлена: ${id}` : `Задача не найдена: ${id}`;
}

/** Выполняет задачу немедленно. */
export async function handleRunNow(scheduler: Scheduler, id: string): Promise<string> {
  const run = await scheduler.runNow(id);
  return run === null ? `Задача не найдена: ${id}` : `Выполнено: ${describeRun(run)}`;
}

/** Поллинг новых результатов клиентом: JSON с запусками новее курсора (для уведомлений). */
export function handlePollResults(scheduler: Scheduler, filter: { since?: string }): string {
  const runs = scheduler.pollResults(filter.since).map(run => ({
    firedAt: run.firedAt,
    taskId: run.taskId,
    taskTitle: run.taskTitle,
    ok: run.ok,
    text: typeof run.details.text === 'string' ? run.details.text : run.summary,
  }));
  return JSON.stringify({ runs });
}

/** История запусков (инбокс). */
export function handleGetHistory(
  scheduler: Scheduler,
  filter: { taskId?: string; limit?: number },
): string {
  const runs = scheduler.getHistory(filter);
  if (runs.length === 0) {
    return 'История пуста.';
  }
  return runs.map(describeRun).join('\n');
}
