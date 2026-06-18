import type { Conversation } from './conversation.ts';
import type { GenerationLimits } from './types.ts';
import type { RunStore } from './run-store.ts';
import type { CompletionArtifact, RunStatus, Stage, StageArtifacts, TaskRun } from './task-run.ts';
import {
  runCompletion,
  runExecution,
  runPlanning,
  runVerification,
  type StageContext,
} from './pipeline-stages.ts';

/** Хуки драйвера (CLI): рендер прогресса и обязательное подтверждение завершения. */
export interface PipelineHooks {
  /** Подтверждение пользователя на этапе completion (обязательный шаг). */
  confirmCompletion: (
    artifact: CompletionArtifact,
  ) => Promise<{ approved: boolean; feedback?: string }>;
  onStageStart?: (stage: Stage) => void;
  /** Этап произвёл артефакт (для печати). */
  onArtifact?: (stage: Stage, artifacts: StageArtifacts) => void;
  /** Авто-возврат в execution (после провала проверки/отказа). */
  onRetry?: (attempt: number, reason: 'verification' | 'rejection') => void;
}

/** Зависимости запуска пайплайна. */
export interface PipelineDeps {
  /** Хранилище прогонов; null — в памяти (--ephemeral), без файлов и продолжения. */
  store: RunStore | null;
  makeConversation: (systemPrompt: string, limits?: GenerationLimits) => Conversation;
  /** Кооперативная отмена/пауза: проверяется между этапами. */
  signal: AbortSignal;
  hooks: PipelineHooks;
  /** Память задачи (детали + профиль) для планирования/выполнения; '' по умолчанию. */
  memoryContext?: string;
}

/** Фиксирует смену статуса/этапа, обновляет время и сохраняет прогон. */
function transition(run: TaskRun, store: RunStore | null, stage: Stage, status: RunStatus): void {
  run.stage = stage;
  run.status = status;
  run.updatedAt = new Date().toISOString();
  run.transitions.push({ stage, status, at: run.updatedAt });
  store?.save(run);
}

/**
 * Прогоняет задачу по фиксированному пайплайну planning→execution→verification→
 * completion (без пропусков). Максимум автономии: этапы идут сами, останавливаемся
 * только на подтверждении завершения, паузе (signal) или исчерпании ретраев.
 * verification-провал/отказ → авто-возврат в execution до maxRetries. Идемпотентен
 * при продолжении: вызывайте снова с тем же run — продолжит с сохранённого этапа.
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

  const ctx: StageContext = {
    run,
    makeConversation: deps.makeConversation,
    writeArtifact: (name, content) => store?.writeArtifact(run.id, name, content) ?? null,
    memoryContext: deps.memoryContext ?? '',
  };

  while (true) {
    if (signal.aborted) {
      transition(run, store, run.stage, 'paused'); // пауза на границе этапа
      return run;
    }
    hooks.onStageStart?.(run.stage);

    if (run.stage === 'planning') {
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
      } else {
        transition(run, store, 'verification', 'paused'); // ретраи исчерпаны — пользователю
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
  }
}
