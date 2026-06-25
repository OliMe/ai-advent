/**
 * Расписание задачи. Три вида: фиксированный интервал, ежедневно в HH:MM по заданному
 * смещению часового пояса, либо однократно в указанный момент.
 */
export type Schedule =
  | { type: 'interval'; everySeconds: number }
  | { type: 'daily'; at: string; tzOffsetMinutes: number }
  | { type: 'once'; atIso: string };

/** Что делает задача при срабатывании (Фаза 1 — без LLM). */
export type TaskKind = 'http_check' | 'note';

/** Состояние задачи в жизненном цикле. */
export type TaskStatus = 'active' | 'paused' | 'completed';

/** Запланированная задача. */
export interface Task {
  /** Уникальный идентификатор. */
  id: string;
  /** Человекочитаемое имя. */
  title: string;
  /** Тип исполнителя. */
  kind: TaskKind;
  /** Цель для http_check (URL). */
  url?: string;
  /** Текст для note. */
  text?: string;
  /** Расписание срабатываний. */
  schedule: Schedule;
  /** Текущее состояние. */
  status: TaskStatus;
  /** Момент создания (ISO). */
  createdAt: string;
  /** Момент следующего срабатывания (ISO); null — планировать нечего (completed). */
  nextFireAt: string | null;
  /** Момент последнего запуска (ISO), если был. */
  lastRunAt?: string;
}

/** Результат одного запуска задачи — запись «инбокса». */
export interface TaskRun {
  /** Идентификатор запуска. */
  id: string;
  /** Задача, к которой относится запуск. */
  taskId: string;
  /** Имя задачи на момент запуска (для читаемой истории). */
  taskTitle: string;
  /** Момент срабатывания (ISO). */
  firedAt: string;
  /** Успех исполнения (для http_check — доступность). */
  ok: boolean;
  /** Краткая сводка результата. */
  summary: string;
  /** Структурные детали (например {status, latencyMs}). */
  details: Record<string, unknown>;
}

/** Полное состояние планировщика для персистентности. */
export interface SchedulerState {
  tasks: Task[];
  runs: TaskRun[];
}
