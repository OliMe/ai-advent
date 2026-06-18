import type { Writable } from 'node:stream';
import { Conversation, createRun, runPipeline } from '../../core/src/index.ts';
import type {
  AppConfig,
  ChatCompletionClient,
  GenerationLimits,
  RunStore,
  TaskRun,
} from '../../core/src/index.ts';
import {
  formatArtifact,
  formatRunList,
  formatRunStatus,
  stageLabel,
  RUNS_EPHEMERAL_NOTICE,
} from './formatters.ts';
import { isAffirmative, isNegative } from './replies.ts';
import { describeError } from './errors.ts';

/** Фабрика диалога этапа: каждый агент получает свой системный промпт и ограничения. */
export type ConversationFactory = (systemPrompt: string, limits?: GenerationLimits) => Conversation;

/** Строит фабрику диалогов для агентов пайплайна на базе клиента и конфигурации. */
export function makeConversationFactory(
  client: ChatCompletionClient,
  config: AppConfig,
  disableThinking: boolean,
  temperature: number,
): ConversationFactory {
  return (systemPrompt, limits) =>
    new Conversation(client, {
      systemPrompt,
      temperature,
      contextTokens: config.contextTokens,
      requestTimeoutMs: config.requestTimeoutMs,
      disableThinking,
      limits,
    });
}

/** Зависимости драйвера прогонов. */
export interface RunControllerDeps {
  /** Хранилище прогонов; null — в памяти (--ephemeral), без файлов и продолжения. */
  store: RunStore | null;
  makeConversation: ConversationFactory;
  output: Writable;
  /** Запрос строки у пользователя (обёртка над readline) — для подтверждения завершения. */
  ask: (prompt: string) => Promise<string>;
}

/**
 * Драйвер прогонов задач для интерактивного режима: запуск/продолжение/статус/
 * правка/досрочное завершение. Кооперативная пауза по Ctrl+C (requestPause) ловится
 * пайплайном на границе этапа. Подтверждение завершения — обязательный шаг.
 */
export class RunController {
  private readonly deps: RunControllerDeps;
  /** Активный прогон сессии (последний запущенный/продолженный). */
  private active: TaskRun | null = null;
  /** Сигнал паузы текущего прогона; не null — пока пайплайн в работе. */
  private pause: AbortController | null = null;

  constructor(deps: RunControllerDeps) {
    this.deps = deps;
  }

  /** Идёт ли прогон прямо сейчас (для решения Ctrl+C: пауза vs выход). */
  isRunning(): boolean {
    return this.pause !== null;
  }

  /** Просит поставить текущий прогон на паузу (сработает на границе этапа). */
  requestPause(): void {
    this.pause?.abort();
  }

  private write(text: string): void {
    this.deps.output.write(`${text}\n\n`);
  }

  /** Запускает новую задачу по пайплайну. */
  async start(title: string): Promise<void> {
    if (!title) {
      this.write('Укажите описание задачи: /run <описание>');
      return;
    }
    const run = createRun(title);
    this.deps.store?.save(run);
    this.active = run;
    this.write(`Запущена задача «${title}» (${run.id}).`);
    await this.drive(run);
  }

  /** Продолжает приостановленный прогон (активный или по id). */
  async continue(idArg: string): Promise<void> {
    let run = this.active;
    if (idArg) {
      run = this.deps.store?.load(idArg) ?? null;
      if (run === null) {
        this.write(`Прогон не найден: ${idArg}`);
        return;
      }
      this.active = run;
    }
    if (run === null) {
      this.write('Нет активного прогона. Запустить: /run <описание>');
      return;
    }
    if (run.status === 'completed') {
      this.write('Прогон уже завершён.');
      return;
    }
    if (run.status === 'cancelled') {
      this.write('Прогон отменён, продолжение невозможно.');
      return;
    }
    this.write(`Продолжаем «${run.title}» с этапа «${stageLabel(run.stage)}».`);
    await this.drive(run);
  }

  /** Показывает статус прогона (активного или по id). */
  status(idArg?: string): void {
    const run = idArg ? (this.deps.store?.load(idArg) ?? null) : this.active;
    if (run === null) {
      this.write(idArg ? `Прогон не найден: ${idArg}` : 'Нет активного прогона.');
      return;
    }
    this.write(formatRunStatus(run).trimEnd());
  }

  /** Список прогонов из хранилища. */
  list(): void {
    if (this.deps.store === null) {
      this.deps.output.write(RUNS_EPHEMERAL_NOTICE);
      return;
    }
    this.deps.output.write(formatRunList(this.deps.store.list()));
  }

  /** Вносит правку в приостановленный прогон (учтётся при продолжении). */
  edit(correction: string): void {
    if (this.active === null) {
      this.write('Нет активного прогона.');
      return;
    }
    if (!correction) {
      this.write('Укажите текст правки: /run edit <текст>');
      return;
    }
    if (this.active.status !== 'paused') {
      this.write('Правку можно внести только на паузе (/run status).');
      return;
    }
    this.active.correction = correction;
    this.deps.store?.save(this.active);
    this.write(`Правка учтена, применится при продолжении: ${correction}`);
  }

  /** Досрочно завершает (отменяет) активный прогон. */
  abort(): void {
    if (this.active === null) {
      this.write('Нет активного прогона.');
      return;
    }
    this.active.status = 'cancelled';
    this.active.updatedAt = new Date().toISOString();
    this.active.transitions.push({
      stage: this.active.stage,
      status: 'cancelled',
      at: this.active.updatedAt,
    });
    this.deps.store?.save(this.active);
    this.write(`Задача «${this.active.title}» завершена досрочно.`);
    this.active = null;
  }

  /** Прогоняет пайплайн с хуками печати/подтверждения; ловит паузу и ошибки. */
  private async drive(run: TaskRun): Promise<void> {
    this.pause = new AbortController();
    try {
      const result = await runPipeline(run, {
        store: this.deps.store,
        makeConversation: this.deps.makeConversation,
        signal: this.pause.signal,
        hooks: {
          onStageStart: stage => this.write(`▸ ${stageLabel(stage)}…`),
          onArtifact: (stage, artifacts) => this.write(formatArtifact(stage, artifacts)),
          onRetry: (attempt, reason) =>
            this.write(
              `↺ возврат в выполнение (${reason === 'verification' ? 'проверка не пройдена' : 'не подтверждено'}), попытка ${attempt}`,
            ),
          confirmCompletion: async artifact => {
            const reply = (
              await this.deps.ask(
                `Итог: ${artifact.summary}\nПодтвердить завершение? (да / нет / опишите правку) `,
              )
            ).trim();
            if (isAffirmative(reply.toLowerCase())) {
              return { approved: true };
            }
            if (isNegative(reply.toLowerCase())) {
              return { approved: false };
            }
            return { approved: false, feedback: reply };
          },
        },
      });
      this.report(result);
    } catch (error) {
      this.write(`[ошибка] ${describeError(error)}`);
    } finally {
      this.pause = null;
    }
  }

  /** Печатает итог прогона после остановки пайплайна. */
  private report(run: TaskRun): void {
    if (run.status === 'completed') {
      this.write(`✓ Задача «${run.title}» завершена и подтверждена.`);
      return;
    }
    // status === 'paused' (единственный другой исход выхода из пайплайна здесь).
    if (run.retries >= run.maxRetries) {
      this.write(
        `⏸ Лимит авто-возвратов (${run.maxRetries}) исчерпан на этапе «${stageLabel(run.stage)}». ` +
          'Внесите правку (/run edit) и продолжите (/run continue) либо завершите (/run abort).',
      );
      return;
    }
    this.write(
      `⏸ Пауза на этапе «${stageLabel(run.stage)}». Продолжить: /run continue; ` +
        'правка: /run edit <текст>; досрочно завершить: /run abort.',
    );
  }
}
