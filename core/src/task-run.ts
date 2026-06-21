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

/** Вклад одного роль-агента команды этапа (роль + её результат). */
export interface AgentContribution {
  role: string;
  text: string;
}

/** Артефакт планирования: шаги + критерии приёмки + читаемый текст. */
export interface PlanningArtifact {
  steps: string[];
  criteria: string[];
  text: string;
  /** Вклады роль-агентов, если план собрала команда (иначе не задано). */
  contributions?: AgentContribution[];
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

// --- Явный автомат жизненного цикла: разрешённые переходы и предусловия этапов ---

/**
 * Разрешённые переходы МЕЖДУ этапами (не считая смены статуса на том же этапе).
 * Перепрыгнуть этап нельзя: например, из requirements можно только в planning.
 */
export const ALLOWED_STAGE_TRANSITIONS: Record<Stage, readonly Stage[]> = {
  requirements: ['planning'],
  planning: ['execution'],
  execution: ['verification'],
  verification: ['execution', 'requirements', 'completion'], // ретрай / возврат к требованиям / приёмка
  completion: ['execution'], // отказ на завершении → доработка
};

/** Разрешён ли прямой переход между этапами по таблице. */
export function isAllowedStageTransition(from: Stage, to: Stage): boolean {
  return ALLOWED_STAGE_TRANSITIONS[from].includes(to);
}

/**
 * Выполнено ли предусловие входа в этап (есть нужный артефакт предыдущего):
 * planning← requirements, execution← planning (утверждённый план), verification←
 * execution, completion← пройденная проверка. requirements — без предусловий.
 */
export function stagePrerequisiteMet(run: TaskRun, stage: Stage): boolean {
  switch (stage) {
    case 'requirements':
      return true;
    case 'planning':
      return run.artifacts.requirements !== undefined;
    case 'execution':
      return run.artifacts.planning !== undefined;
    case 'verification':
      return run.artifacts.execution !== undefined;
    case 'completion':
      return run.artifacts.verification?.passed === true;
  }
}

/** Результат проверки перехода: либо разрешено, либо причина отказа. */
export type TransitionCheck = { ok: true } | { ok: false; reason: string };

/** Можно ли перевести прогон в этап `to`: ребро таблицы + предусловие (тот же этап — да). */
export function canTransition(run: TaskRun, to: Stage): TransitionCheck {
  if (run.stage === to) {
    return { ok: true }; // смена статуса на том же этапе
  }
  if (!isAllowedStageTransition(run.stage, to)) {
    return { ok: false, reason: `переход «${run.stage}» → «${to}» не разрешён` };
  }
  if (!stagePrerequisiteMet(run, to)) {
    return { ok: false, reason: `не выполнено предусловие этапа «${to}»` };
  }
  return { ok: true };
}

/** Ошибка недопустимого перехода жизненного цикла прогона. */
export class InvalidTransitionError extends Error {
  readonly from: Stage;
  readonly to: Stage;
  constructor(from: Stage, to: Stage, reason: string) {
    super(`Недопустимый переход «${from}» → «${to}»: ${reason}`);
    this.name = 'InvalidTransitionError';
    this.from = from;
    this.to = to;
  }
}

/**
 * Валидированный переход: проверяет допустимость (ребро + предусловие) и применяет
 * смену этапа/статуса к прогону. Недопустимый переход → {@link InvalidTransitionError}.
 */
export function applyTransition(run: TaskRun, to: Stage, status: RunStatus): void {
  const check = canTransition(run, to);
  if (!check.ok) {
    throw new InvalidTransitionError(run.stage, to, check.reason);
  }
  run.stage = to;
  run.status = status;
  run.updatedAt = new Date().toISOString();
  run.transitions.push({ stage: to, status, at: run.updatedAt });
}

/**
 * Чинит несогласованное состояние при возобновлении: пока предусловие текущего этапа
 * не выполнено, откатывается к предыдущему этапу (до requirements). Никогда не двигает
 * вперёд — легитимный возврат к сбору требований не нарушается. Возвращает прежний этап.
 */
export function repairStage(run: TaskRun): Stage {
  const before = run.stage;
  while (run.stage !== 'requirements' && !stagePrerequisiteMet(run, run.stage)) {
    run.stage = STAGES[STAGES.indexOf(run.stage) - 1];
  }
  return before;
}
