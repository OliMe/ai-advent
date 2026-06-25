import type {
  SchedulerState,
  Task,
  TaskKind,
  TaskRun,
  Schedule,
  DeliveryChannel,
} from './types.ts';
import type { TaskStore } from './task-store.ts';
import type { Executor } from './executors.ts';
import { nextFireTime, validateSchedule } from './schedule.ts';

/** Сколько последних запусков хранить на задачу (потолок истории). */
const MAX_RUNS_PER_TASK = 200;

/** Входные данные на создание задачи. */
export interface ScheduleTaskInput {
  title: string;
  kind: TaskKind;
  url?: string;
  text?: string;
  instruction?: string;
  deliver?: DeliveryChannel;
  schedule: Schedule;
}

/** Доставка результата запуска во внешний канал (best-effort, ошибки не бросает). */
export type DeliverFn = (run: TaskRun, task: Task) => Promise<void>;

/** Зависимости движка: хранилище, исполнители, часы, генератор id и (опц.) доставка. */
export interface SchedulerDeps {
  store: TaskStore;
  executors: Record<TaskKind, Executor>;
  now: () => number;
  idFactory: () => string;
  deliver?: DeliverFn;
}

/** ISO-строка из epoch-мс. */
function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Движок планировщика: держит состояние в памяти (читает из хранилища при старте, пишет при
 * каждом изменении), исполняет «созревшие» задачи на `tick()`. Периодический вызов `tick` —
 * за пределами движка (тонкая точка входа), чтобы логика оставалась тестируемой.
 */
export class Scheduler {
  private readonly deps: SchedulerDeps;
  private state: SchedulerState;

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
    this.state = deps.store.read();
  }

  /** Создаёт и ставит задачу в план; возвращает созданную задачу. Бросает при неверном вводе. */
  scheduleTask(input: ScheduleTaskInput): Task {
    if (input.kind === 'http_check' && !input.url?.trim()) {
      throw new Error('Для http_check нужен непустой url.');
    }
    if (input.kind === 'note' && !input.text?.trim()) {
      throw new Error('Для note нужен непустой text.');
    }
    if (input.kind === 'agent' && !input.instruction?.trim()) {
      throw new Error('Для agent нужна непустая instruction.');
    }
    validateSchedule(input.schedule);
    const nowMs = this.deps.now();
    const task: Task = {
      id: this.deps.idFactory(),
      title: input.title,
      kind: input.kind,
      deliver: input.deliver ?? 'inbox',
      schedule: input.schedule,
      status: 'active',
      createdAt: toIso(nowMs),
      nextFireAt: toIso(nextFireTime(input.schedule, nowMs)),
      ...(input.url !== undefined ? { url: input.url } : {}),
      ...(input.text !== undefined ? { text: input.text } : {}),
      ...(input.instruction !== undefined ? { instruction: input.instruction } : {}),
    };
    this.state.tasks.push(task);
    this.persist();
    return task;
  }

  /** Все задачи. */
  listTasks(): Task[] {
    return this.state.tasks;
  }

  /** Задача с её историей запусков или null, если не найдена. */
  getTask(id: string): { task: Task; runs: TaskRun[] } | null {
    const task = this.findTask(id);
    if (task === null) {
      return null;
    }
    return { task, runs: this.historyFor(id) };
  }

  /** Удаляет задачу (история запусков остаётся в инбоксе). true — если была. */
  cancelTask(id: string): boolean {
    const index = this.state.tasks.findIndex(task => task.id === id);
    if (index === -1) {
      return false;
    }
    this.state.tasks.splice(index, 1);
    this.persist();
    return true;
  }

  /** Ставит задачу на паузу (тик её пропускает). true — если найдена. */
  pauseTask(id: string): boolean {
    const task = this.findTask(id);
    if (task === null) {
      return false;
    }
    task.status = 'paused';
    this.persist();
    return true;
  }

  /** Снимает с паузы и пересчитывает ближайшее срабатывание от текущего момента. */
  resumeTask(id: string): boolean {
    const task = this.findTask(id);
    if (task === null) {
      return false;
    }
    task.status = 'active';
    task.nextFireAt = toIso(nextFireTime(task.schedule, this.deps.now()));
    this.persist();
    return true;
  }

  /** Выполняет задачу немедленно (не меняя расписание); возвращает запуск или null. */
  async runNow(id: string): Promise<TaskRun | null> {
    const task = this.findTask(id);
    if (task === null) {
      return null;
    }
    const run = await this.runExecutor(task, this.deps.now());
    this.persist();
    return run;
  }

  /** История запусков (новые первыми), опц. по задаче и с ограничением количества. */
  getHistory(filter: { taskId?: string; limit?: number } = {}): TaskRun[] {
    const limit = filter.limit ?? 50;
    const runs = filter.taskId === undefined ? this.state.runs : this.historyFor(filter.taskId);
    return [...runs].reverse().slice(0, limit);
  }

  /** Исполняет все «созревшие» активные задачи; возвращает сработавшие запуски. */
  async tick(): Promise<TaskRun[]> {
    const nowMs = this.deps.now();
    const fired: TaskRun[] = [];
    for (const task of this.state.tasks) {
      if (task.status !== 'active' || task.nextFireAt === null) {
        continue;
      }
      if (Date.parse(task.nextFireAt) > nowMs) {
        continue;
      }
      fired.push(await this.runExecutor(task, nowMs));
      this.reschedule(task, nowMs);
    }
    if (fired.length > 0) {
      this.persist();
    }
    return fired;
  }

  /** Запускает исполнитель задачи, записывает результат в инбокс и отметку lastRunAt. */
  private async runExecutor(task: Task, firedMs: number): Promise<TaskRun> {
    const outcome = await this.deps.executors[task.kind](task);
    const run: TaskRun = {
      id: this.deps.idFactory(),
      taskId: task.id,
      taskTitle: task.title,
      firedAt: toIso(firedMs),
      ok: outcome.ok,
      summary: outcome.summary,
      details: outcome.details,
    };
    this.appendRun(run);
    task.lastRunAt = toIso(firedMs);
    if (this.deps.deliver !== undefined) {
      await this.deps.deliver(run, task);
    }
    return run;
  }

  /** Пересчитывает следующий запуск после срабатывания (once — завершает задачу). */
  private reschedule(task: Task, firedMs: number): void {
    if (task.schedule.type === 'once') {
      task.status = 'completed';
      task.nextFireAt = null;
      return;
    }
    task.nextFireAt = toIso(nextFireTime(task.schedule, firedMs));
  }

  /** Добавляет запуск в инбокс с потолком истории на задачу. */
  private appendRun(run: TaskRun): void {
    this.state.runs.push(run);
    const sameTask = this.state.runs.filter(item => item.taskId === run.taskId);
    if (sameTask.length > MAX_RUNS_PER_TASK) {
      const oldest = sameTask[0];
      this.state.runs.splice(this.state.runs.indexOf(oldest), 1);
    }
  }

  /** Находит задачу по id или null. */
  private findTask(id: string): Task | null {
    return this.state.tasks.find(task => task.id === id) ?? null;
  }

  /** Запуски конкретной задачи в порядке появления. */
  private historyFor(taskId: string): TaskRun[] {
    return this.state.runs.filter(run => run.taskId === taskId);
  }

  /** Сохраняет состояние в хранилище. */
  private persist(): void {
    this.deps.store.write(this.state);
  }
}
