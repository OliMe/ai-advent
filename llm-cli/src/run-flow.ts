import type { Writable } from 'node:stream';
import { Conversation, createRun, runPipeline } from '../../core/src/index.ts';
import type {
  AppConfig,
  ChatCompletionClient,
  GenerationLimits,
  RunStore,
  Task,
  TaskRun,
} from '../../core/src/index.ts';
import {
  formatStageResult,
  formatRunList,
  formatRunStatus,
  stageLabel,
  RUNS_EPHEMERAL_NOTICE,
} from './formatters.ts';
import { isAffirmative, isNegative } from './replies.ts';
import { describeError } from './errors.ts';

/** Фабрика диалога этапа: каждый агент получает свой системный промпт и ограничения. */
export type ConversationFactory = (systemPrompt: string, limits?: GenerationLimits) => Conversation;

const JSON_LIMITS: GenerationLimits = { responseFormat: { type: 'json_object' } };

/** Персона агента-аналитика: уточняет требования ДО планирования. */
const CLARIFIER_SYSTEM =
  'Ты — аналитик требований. По формулировке задачи задай минимально необходимые ' +
  'уточняющие вопросы, чтобы снять неоднозначности перед решением: цель, объём, ограничения, ' +
  'формат результата, крайние случаи. Не задавай лишних вопросов, если и так всё ясно. ' +
  'Верни СТРОГО JSON: {"questions": ["...", "..."]}. Если уточнять нечего — {"questions": []}.';

/** Извлекает список уточняющих вопросов из ответа аналитика (лениво). */
export function parseQuestions(content: string): string[] {
  try {
    const parsed: unknown = JSON.parse(content);
    const questions = (parsed as { questions?: unknown } | null)?.questions;
    return Array.isArray(questions)
      ? questions
          .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
          .map(item => item.trim())
      : [];
  } catch {
    return [];
  }
}

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

/**
 * Мост к памяти задач: связывает прогон с задачей сессии. Реализация (MemoryRunBridge)
 * живёт поверх MemoryManager; здесь — только контракт, нужный драйверу.
 */
export interface RunTaskBridge {
  /** Текущая задача сессии (или null). */
  current(): Task | null;
  /** Находит задачу по id/имени, иначе создаёт новую; делает её текущей. */
  resolveOrCreate(arg: string): Task;
  /** Делает задачу текущей (при продолжении прогона по её id). */
  adopt(taskId: string): void;
  /** Дописывает факт/требование в детали текущей задачи. */
  addDetail(text: string): void;
  /** Контекст памяти текущей задачи (детали + профиль) для агентов пайплайна. */
  memoryContext(): string;
  /** Пишет итог в память текущей задачи и помечает её done; true — задача найдена. */
  complete(summary: string): boolean;
}

/** Зависимости драйвера прогонов. */
export interface RunControllerDeps {
  /** Хранилище прогонов; null — в памяти (--ephemeral), без файлов и продолжения. */
  store: RunStore | null;
  makeConversation: ConversationFactory;
  output: Writable;
  /** Запрос строки у пользователя (обёртка над readline) — для подтверждения завершения. */
  ask: (prompt: string) => Promise<string>;
  /** Связь прогона с задачей сессии (память на вход, итог на выход). */
  taskBridge: RunTaskBridge;
  /** Пишет результат этапа в транскрипт основной сессии (если задан). */
  recordToSession?: (role: 'user' | 'assistant', content: string) => void;
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

  /** Записывает реплику прогона в транскрипт основной сессии (если включено). */
  private record(role: 'user' | 'assistant', content: string): void {
    this.deps.recordToSession?.(role, content);
  }

  /**
   * Запускает прогон задачи: без аргумента — текущей задачи сессии; с аргументом —
   * существующей (по id/имени) или новой (по описанию). Прогон привязывается к задаче.
   */
  async start(arg: string): Promise<void> {
    let task: Task | null;
    if (arg) {
      task = this.deps.taskBridge.resolveOrCreate(arg);
    } else {
      task = this.deps.taskBridge.current();
      if (task === null) {
        this.write('Нет текущей задачи. Задайте /task <описание> или /run <описание>.');
        return;
      }
    }
    const run = createRun(task.title, { taskId: task.id });
    this.deps.store?.save(run);
    this.active = run;
    this.write(`Запущена задача «${task.title}» (${run.id}).`);
    this.record('user', `Запуск задачи по этапам: «${task.title}»`);
    await this.drive(run, task); // task !== null → сперва соберём требования
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
    // Возобновляем задачу прогона как текущую — её память пойдёт в этапы.
    if (run.taskId !== undefined) {
      this.deps.taskBridge.adopt(run.taskId);
    }
    this.write(`Продолжаем «${run.title}» с этапа «${stageLabel(run.stage)}».`);
    this.record('user', `Продолжение прогона «${run.title}» с этапа «${stageLabel(run.stage)}»`);
    await this.drive(run, null); // продолжение — требования уже собраны
  }

  /**
   * Сбор требований ДО планирования: аналитик задаёт уточняющие вопросы, ответы
   * пишутся в детали задачи (и в транскрипт). Нет вопросов — сразу дальше. Сбой
   * аналитика не блокирует прогон. Прерывается на границе вопроса по signal.
   */
  private async gatherRequirements(task: Task, signal: AbortSignal): Promise<void> {
    const conversation = this.deps.makeConversation(CLARIFIER_SYSTEM, JSON_LIMITS);
    const context = this.deps.taskBridge.memoryContext();
    const prefix = context ? `${context}\n\n` : '';
    let questions: string[];
    try {
      const result = await conversation.ask(
        `${prefix}Задача: ${task.title}\n\nЗадай уточняющие вопросы по требованиям, если нужно.`,
      );
      questions = parseQuestions(result.content);
    } catch (error) {
      this.write(`[уточнение пропущено] ${describeError(error)}`); // не валим прогон
      return;
    }
    if (questions.length === 0) {
      return; // задача ясна — уточнять нечего
    }
    this.write('▸ уточнение требований…');
    for (const question of questions) {
      if (signal.aborted) break; // опрос прерван пользователем
      const answer = (await this.deps.ask(`❓ ${question}\n   ответ: `)).trim();
      if (answer) {
        this.deps.taskBridge.addDetail(`Требование: ${question} → ${answer}`);
        this.record('user', `${question} → ${answer}`);
      }
    }
    this.write('Требования собраны и записаны в задачу.');
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

  /**
   * Прогоняет пайплайн с хуками печати/подтверждения; ловит паузу и ошибки. Перед
   * первым запуском (task !== null) собирает требования у пользователя.
   */
  private async drive(run: TaskRun, task: Task | null): Promise<void> {
    this.pause = new AbortController();
    try {
      if (task !== null) {
        await this.gatherRequirements(task, this.pause.signal);
      }
      const result = await runPipeline(run, {
        store: this.deps.store,
        makeConversation: this.deps.makeConversation,
        signal: this.pause.signal,
        memoryContext: this.deps.taskBridge.memoryContext(),
        hooks: {
          onStageStart: stage => this.write(`▸ ${stageLabel(stage)}…`),
          onArtifact: (stage, artifacts) => {
            // Полный читаемый результат этапа — в консоль и в транскрипт сессии.
            const result = formatStageResult(stage, artifacts);
            this.write(result);
            this.record('assistant', `[${stageLabel(stage)}]\n${result}`);
          },
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
      if (result.status === 'completed') {
        // Итог прогона возвращаем в память задачи; задача помечается выполненной.
        // На статусе completed артефакт завершения гарантированно есть (его ставит оркестратор).
        const recorded = this.deps.taskBridge.complete(result.artifacts.completion!.summary);
        this.write(
          `✓ Задача «${run.title}» завершена и подтверждена.` +
            (recorded ? ' Итог записан в память задачи, задача помечена выполненной.' : ''),
        );
      } else {
        this.reportPaused(result);
      }
    } catch (error) {
      this.write(`[ошибка] ${describeError(error)}`);
    } finally {
      this.pause = null;
    }
  }

  /** Печатает пояснение к паузе прогона (исчерпание ретраев или пользовательская пауза). */
  private reportPaused(run: TaskRun): void {
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
