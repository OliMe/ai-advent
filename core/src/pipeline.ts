import type { Conversation } from './conversation.ts';
import type { GenerationLimits } from './types.ts';
import type { RunStore } from './run-store.ts';
import type { CompletionArtifact, RunStatus, Stage, StageArtifacts, TaskRun } from './task-run.ts';
import { applyTransition, repairStage } from './task-run.ts';
import type { TeamPlan } from './stage-team.ts';
import type { ToolSet } from './tool-set.ts';
import {
  runCompletion,
  runExecution,
  runPlanning,
  runVerification,
  type StageContext,
} from './pipeline-stages.ts';
import {
  enforceInvariants,
  InvariantViolationError,
  INVARIANT_CHECKER_SYSTEM,
} from './invariant-guard.ts';

/** Хуки драйвера (CLI): рендер прогресса, интерактивный сбор требований, подтверждение. */
export interface PipelineHooks {
  /** Подтверждение пользователя на этапе completion (обязательный шаг). */
  confirmCompletion: (
    artifact: CompletionArtifact,
  ) => Promise<{ approved: boolean; feedback?: string }>;
  /**
   * Интерактивный сбор требований (этап requirements): диалог аналитика с
   * пользователем. `issues` — замечания прошлой проверки (пусто на первом проходе),
   * `cycle` — номер текущего цикла сбора. Возвращает собранные пункты «вопрос → ответ».
   */
  gatherRequirements?: (context: {
    issues: string[];
    cycle: number;
  }) => Promise<{ collected: string[] }>;
  onStageStart?: (stage: Stage) => void;
  /** Этап произвёл артефакт (для печати). */
  onArtifact?: (stage: Stage, artifacts: StageArtifacts) => void;
  /** Авто-возврат в execution (после провала проверки/отказа). */
  onRetry?: (attempt: number, reason: 'verification' | 'rejection') => void;
  /** Лимит провалов проверки исчерпан → возврат к сбору требований (цикл K из M). */
  onRegather?: (cycle: number) => void;
  /**
   * Контролёр инвариантов нашёл нарушение в результате решающего агента. `fatal` —
   * перегенерации исчерпаны (этап встаёт на паузу); иначе идёт перегенерация.
   */
  onInvariantViolation?: (info: { stage: Stage; violations: string[]; fatal: boolean }) => void;
  /**
   * Несогласованное состояние при возобновлении исправлено откатом этапа `from`→`to`
   * (артефакты предыдущих этапов отсутствовали). Чтобы нельзя было «перепрыгнуть» этап.
   */
  onStageRepair?: (from: Stage, to: Stage) => void;
  /** Оркестратор подобрал команду агентов на этап (для печати решения). */
  onTeam?: (stage: Stage, team: TeamPlan) => void;
}

/** Зависимости запуска пайплайна. */
export interface PipelineDeps {
  /** Хранилище прогонов; null — в памяти (--ephemeral), без файлов и продолжения. */
  store: RunStore | null;
  makeConversation: (
    systemPrompt: string,
    limits?: GenerationLimits,
    temperature?: number,
    tools?: ToolSet,
  ) => Conversation;
  /** Кооперативная отмена/пауза: проверяется между этапами. */
  signal: AbortSignal;
  hooks: PipelineHooks;
  /**
   * Память задачи (детали + профиль) для планирования/выполнения — провайдер, чтобы
   * требования, собранные на этапе requirements, сразу попадали в контекст. По умолчанию пусто.
   */
  memoryContext?: () => string;
  /** Инварианты для жёсткого контроля решающих агентов; пусто/не задан — контроль выключен. */
  invariants?: () => string[];
  /**
   * Конфиг команды агентов на этап: потолок ролей и конкурентность веера. Не задан —
   * многоагентность выключена (однопроходный режим, оркестратор не вызывается).
   */
  teamConfig?: { maxAgents: number; concurrency: number };
  /** Инструменты (function-calling) для решающих агентов планирования/выполнения. */
  tools?: ToolSet;
  /**
   * Структурированный вывод этапов по JSON-схеме. Не задан/false — прежний путь
   * (JSON в промпте + толерантный парсер), безопасный для z.ai/GLM.
   */
  structuredOutputs?: boolean;
}

/**
 * Валидированная смена этапа/статуса: applyTransition проверяет допустимость перехода
 * (таблица + предусловия) и бросает InvalidTransitionError на недопустимом; затем сохраняем.
 */
function transition(run: TaskRun, store: RunStore | null, stage: Stage, status: RunStatus): void {
  applyTransition(run, stage, status);
  store?.save(run);
}

/**
 * Прогоняет задачу по фиксированному пайплайну requirements→planning→execution→
 * verification→completion (без пропусков). Максимум автономии: этапы идут сами,
 * останавливаемся только на подтверждении завершения, паузе (signal) или исчерпании
 * лимитов. verification-провал → авто-возврат в execution до maxRetries; при исчерпании
 * — возврат к сбору требований (со сбросом счётчика) до maxRequirementCycles, затем
 * пауза. Идемпотентен при продолжении: вызывайте снова с тем же run.
 */
export async function runPipeline(run: TaskRun, deps: PipelineDeps): Promise<TaskRun> {
  const { store, signal, hooks } = deps;
  // Продолжение завершённого/отменённого прогона — no-op.
  if (run.status === 'completed' || run.status === 'cancelled') {
    return run;
  }
  if (run.status === 'paused') {
    run.status = 'running'; // возобновляем
  }
  // Возобновление чинит несогласованность: если этап «впереди» своих артефактов
  // (повреждённый/правленый прогон), откатываемся — перепрыгнуть этап нельзя.
  const stageBeforeRepair = repairStage(run);
  if (run.stage !== stageBeforeRepair) {
    run.updatedAt = new Date().toISOString();
    run.transitions.push({ stage: run.stage, status: run.status, at: run.updatedAt });
    store?.save(run);
    hooks.onStageRepair?.(stageBeforeRepair, run.stage);
  }

  const ctx: StageContext = {
    run,
    makeConversation: deps.makeConversation,
    writeArtifact: (name, content) => store?.writeArtifact(run.id, name, content) ?? null,
    memoryContext: deps.memoryContext ?? (() => ''),
    maxStageAgents: deps.teamConfig?.maxAgents,
    stageAgentConcurrency: deps.teamConfig?.concurrency,
    reportTeam: team => hooks.onTeam?.(run.stage, team),
    tools: deps.tools,
    structuredOutputs: deps.structuredOutputs,
    // Защищённая генерация решающих этапов: контролёр сверяет результат с инвариантами.
    enforce: produce =>
      enforceInvariants({
        invariants: deps.invariants?.() ?? [],
        makeChecker: () => deps.makeConversation(INVARIANT_CHECKER_SYSTEM, undefined, 0),
        produce,
        onViolation: violations =>
          hooks.onInvariantViolation?.({ stage: run.stage, violations, fatal: false }),
      }),
  };

  while (true) {
    if (signal.aborted) {
      transition(run, store, run.stage, 'paused'); // пауза на границе этапа
      return run;
    }
    hooks.onStageStart?.(run.stage);

    try {
      if (run.stage === 'requirements') {
        const issues = run.artifacts.verification?.issues ?? [];
        const gathered = (await hooks.gatherRequirements?.({
          issues,
          cycle: run.requirementCycles,
        })) ?? { collected: [] };
        run.artifacts.requirements = {
          collected: gathered.collected,
          text: gathered.collected.join('\n'),
        };
        hooks.onArtifact?.('requirements', run.artifacts);
        if (signal.aborted) {
          transition(run, store, 'requirements', 'paused'); // прерван опрос — продолжим с него
          return run;
        }
        // Замечания прошлой проверки учтены при сборе — не тянем их в новый план/выполнение.
        run.artifacts.verification = undefined;
        transition(run, store, 'planning', 'running');
      } else if (run.stage === 'planning') {
        run.artifacts.planning = await runPlanning(ctx);
        run.correction = undefined; // правка учтена
        hooks.onArtifact?.('planning', run.artifacts);
        transition(run, store, 'execution', 'running');
      } else if (run.stage === 'execution') {
        run.artifacts.execution = await runExecution(ctx);
        run.correction = undefined;
        hooks.onArtifact?.('execution', run.artifacts);
        transition(run, store, 'verification', 'running');
      } else if (run.stage === 'verification') {
        const verification = await runVerification(ctx);
        run.artifacts.verification = verification;
        hooks.onArtifact?.('verification', run.artifacts);
        if (verification.passed) {
          transition(run, store, 'completion', 'running');
        } else if (run.retries < run.maxRetries) {
          run.retries++;
          hooks.onRetry?.(run.retries, 'verification');
          transition(run, store, 'execution', 'running');
        } else if (run.requirementCycles < run.maxRequirementCycles) {
          // Лимит провалов проверки исчерпан — возвращаемся к сбору требований,
          // счётчик проверок сбрасываем, цикл сбора инкрементируем.
          run.requirementCycles++;
          run.retries = 0;
          hooks.onRegather?.(run.requirementCycles);
          transition(run, store, 'requirements', 'running');
        } else {
          // Исчерпан и лимит циклов сбора требований — пауза пользователю.
          transition(run, store, 'verification', 'paused');
          return run;
        }
      } else {
        // completion
        run.artifacts.completion = await runCompletion(ctx);
        hooks.onArtifact?.('completion', run.artifacts);
        const { approved, feedback } = await hooks.confirmCompletion(run.artifacts.completion);
        if (approved) {
          transition(run, store, 'completion', 'completed');
          return run;
        }
        if (run.retries < run.maxRetries) {
          run.retries++;
          run.correction = feedback;
          hooks.onRetry?.(run.retries, 'rejection');
          transition(run, store, 'execution', 'running');
        } else {
          transition(run, store, 'completion', 'paused');
          return run;
        }
      }
    } catch (error) {
      // Контролёр не смог добиться соблюдения инвариантов — пауза на текущем этапе.
      if (error instanceof InvariantViolationError) {
        hooks.onInvariantViolation?.({
          stage: run.stage,
          violations: error.violations,
          fatal: true,
        });
        transition(run, store, run.stage, 'paused');
        return run;
      }
      throw error;
    }
  }
}
