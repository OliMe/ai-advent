/**
 * Расписание задачи. Три вида: фиксированный интервал, ежедневно в HH:MM по заданному
 * смещению часового пояса, либо однократно в указанный момент.
 */
export type Schedule =
  | { type: 'interval'; everySeconds: number }
  | { type: 'daily'; at: string; tzOffsetMinutes: number }
  | { type: 'once'; atIso: string };

/**
 * Что делает задача при срабатывании. agent — NL-инструкция исполняется LLM (Фаза 2);
 * system_metrics — снимок метрик VPS (+ опц. доступность url); report — агрегат по серии
 * метрик другой задачи (targetTaskId) (Фаза 3).
 */
export type TaskKind = 'http_check' | 'note' | 'agent' | 'system_metrics' | 'report' | 'digest';

/** Канал доставки результата запуска. inbox — только в историю; telegram — ещё и в Telegram. */
export type DeliveryChannel = 'inbox' | 'telegram';

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
  /** URL эндпоинта метрик (например /metrics OCR) для system_metrics — читаем поле requests. */
  metricsUrl?: string;
  /** Текст для note. */
  text?: string;
  /** Инструкция на естественном языке для kind=agent. */
  instruction?: string;
  /** Целевая задача-сборщик метрик для kind=report (агрегируем её историю). */
  targetTaskId?: string;
  /** Канал доставки результата (по умолчанию inbox). */
  deliver: DeliveryChannel;
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
