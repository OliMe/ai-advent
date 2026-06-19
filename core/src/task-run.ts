import { randomBytes } from 'node:crypto';
import { sessionId } from './session.ts';

/** Версия формата файла прогона — для будущих миграций. */
export const RUN_VERSION = 1;
/**
 * Сколько провалов проверки подряд допустимо до возврата к сбору требований.
 * При исчерпании прогон не встаёт на паузу, а заново собирает требования (счётчик сброшен).
 */
export const DEFAULT_MAX_RETRIES = 10;

/**
 * Сколько полных возвратов к сбору требований допустимо до паузы. Защита от
 * бесконечного цикла «требования → планирование → … → требования».
 */
export const DEFAULT_MAX_REQUIREMENT_CYCLES = 3;

/** Фиксированные этапы пайплайна в строгом порядке (пропуск запрещён). */
export const STAGES = [
  'requirements',
  'planning',
  'execution',
  'verification',
  'completion',
] as const;
export type Stage = (typeof STAGES)[number];

/** Состояние прогона: идёт / на паузе / завершён / отменён. */
export type RunStatus = 'running' | 'paused' | 'completed' | 'cancelled';

/** Артефакт сбора требований: собранные пары «вопрос → ответ» + читаемый текст. */
export interface RequirementsArtifact {
  collected: string[];
  text: string;
}

/** Артефакт планирования: шаги + критерии приёмки + читаемый текст. */
export interface PlanningArtifact {
  steps: string[];
  criteria: string[];
  text: string;
}

/** Артефакт выполнения: краткое резюме, ссылки на файлы-результаты, лог, текст. */
export interface ExecutionArtifact {
  summary: string;
  files: string[];
  log: string[];
  text: string;
}

/** Артефакт проверки: вердикт + список проблем + текст. */
export interface VerificationArtifact {
  passed: boolean;
  issues: string[];
  text: string;
}

/** Артефакт завершения: итоговое резюме + текст. */
export interface CompletionArtifact {
  summary: string;
  text: string;
}

/** Артефакты по этапам (заполняются по мере прохождения). */
export interface StageArtifacts {
  requirements?: RequirementsArtifact;
  planning?: PlanningArtifact;
  execution?: ExecutionArtifact;
  verification?: VerificationArtifact;
  completion?: CompletionArtifact;
}

/** Запись о смене этапа/статуса (аудит). */
export interface RunTransition {
  stage: Stage;
  status: RunStatus;
  at: string;
}

/** Прогон задачи через пайплайн: состояние автомата + артефакты, переживает рестарт. */
export interface TaskRun {
  version: number;
  id: string;
  /** id задачи, к которой привязан прогон (если есть). */
  taskId?: string;
  title: string;
  stage: Stage;
  status: RunStatus;
  artifacts: StageArtifacts;
  /** Сколько авто-возвратов в execution сделано с последнего сбора требований. */
  retries: number;
  maxRetries: number;
  /** Сколько полных возвратов к сбору требований уже сделано. */
  requirementCycles: number;
  maxRequirementCycles: number;
  /** Правка пользователя, учитываемая при перезапуске текущего этапа. */
  correction?: string;
  transitions: RunTransition[];
  createdAt: string;
  updatedAt: string;
}

/** Короткая сводка прогона для списка. */
export interface RunSummary {
  id: string;
  title: string;
  stage: Stage;
  status: RunStatus;
  updatedAt: string;
}

/** Случайный суффикс id (6 hex-символов). */
function randomSuffix(): string {
  return randomBytes(3).toString('hex');
}

/** Создаёт новый прогон на этапе planning. */
export function createRun(
  title: string,
  options: {
    taskId?: string;
    maxRetries?: number;
    maxRequirementCycles?: number;
    now?: Date;
    idSuffix?: string;
  } = {},
): TaskRun {
  const now = options.now ?? new Date();
  const timestamp = now.toISOString();
  return {
    version: RUN_VERSION,
    id: sessionId(now, options.idSuffix ?? randomSuffix()),
    ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
    title,
    stage: 'requirements',
    status: 'running',
    artifacts: {},
    retries: 0,
    maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
    requirementCycles: 0,
    maxRequirementCycles: options.maxRequirementCycles ?? DEFAULT_MAX_REQUIREMENT_CYCLES,
    transitions: [{ stage: 'requirements', status: 'running', at: timestamp }],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/** Следующий этап по порядку или null, если текущий — последний. */
export function nextStage(stage: Stage): Stage | null {
  const index = STAGES.indexOf(stage);
  return index >= 0 && index < STAGES.length - 1 ? STAGES[index + 1] : null;
}

/** Строит сводку прогона для списка. */
export function summarizeRun(run: TaskRun): RunSummary {
  return {
    id: run.id,
    title: run.title,
    stage: run.stage,
    status: run.status,
    updatedAt: run.updatedAt,
  };
}
