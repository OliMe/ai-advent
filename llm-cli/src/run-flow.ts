import type { Writable } from 'node:stream';
import { Conversation, createRun, runPipeline, extractJsonObject } from '../../core/src/index.ts';
import type {
  AppConfig,
  ChatCompletionClient,
  GenerationLimits,
  RunStore,
  Task,
  TaskRun,
  ToolSet,
  Usage,
} from '../../core/src/index.ts';
import {
  formatStageResult,
  formatRunList,
  formatRunStatus,
  formatTeam,
  stageLabel,
  RUNS_EPHEMERAL_NOTICE,
} from './formatters.ts';
import { isAffirmative, isNegative } from './replies.ts';
import { describeError } from './errors.ts';

/** Фабрика диалога этапа: системный промпт, ограничения, температура и (опц.) инструменты. */
export type ConversationFactory = (
  systemPrompt: string,
  limits?: GenerationLimits,
  temperature?: number,
  tools?: ToolSet,
) => Conversation;

/** Максимум вопросов аналитика за один сбор требований (страховка от зацикливания). */
const MAX_CLARIFIER_QUESTIONS = 20;

/**
 * Низко-умеренная температура аналитика: уточняющие вопросы и подсказки-дефолты стабильнее и по
 * делу (слабая модель на 0.7 давала мета-описания вместо конкретных ответов-подсказок). С
 * response_format не связано → безопасно для всех провайдеров.
 */
const CLARIFIER_TEMPERATURE = 0.3;

/** Слова пользователя, завершающие опрос требований досрочно. */
const STOP_WORDS = new Set(['стоп', 'достаточно', 'хватит', 'хорош', 'всё', 'все']);

/** Персона агента-аналитика: ведёт уточнение требований ПО ОДНОМУ вопросу адаптивно. */
const CLARIFIER_SYSTEM =
  'Ты — аналитик требований. Веди уточнение ПО ОДНОМУ вопросу за ход, опираясь на уже ' +
  'полученные ответы (и, если даны, замечания проверки), чтобы снять неоднозначности перед ' +
  'решением: цель, объём, ограничения, формат результата, крайние случаи. Каждый следующий ' +
  'вопрос выбирай с учётом предыдущих ответов. К каждому вопросу предлагай наиболее подходящий ' +
  'ответ по умолчанию. Если в контексте даны ИНВАРИАНТЫ — строго соблюдай их: не задавай ' +
  'вопросов и не предлагай подсказок, которые их нарушают. Если ответ пользователя нарушает ' +
  'инвариант — НЕ принимай его как требование: отметь конфликт и направь к совместимому ' +
  'варианту (инварианты важнее пожеланий). Когда требований достаточно — заверши. ' +
  'Верни СТРОГО JSON: {"question": "следующий вопрос", "suggestion": "предлагаемый ответ"} либо {"done": true}.';

/** Шаг диалога аналитика: либо следующий вопрос с подсказкой, либо признак завершения. */
export type ClarifierStep = { done: true } | { done: false; question: string; suggestion: string };

/** Разбирает ответ аналитика: вопрос+подсказка или «готово» (лениво, с фолбэком на done). */
export function parseClarifierStep(content: string): ClarifierStep {
  // JSON просим в промпте (без response_format); парсим целиком, иначе первый блок {…}.
  const candidate = content.trim().startsWith('{')
    ? content
    : (extractJsonObject(content) ?? content);
  let parsed: { done?: unknown; question?: unknown; suggestion?: unknown } | null;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return { done: true }; // не разобрали — считаем, что уточнять нечего
  }
  const question = typeof parsed?.question === 'string' ? parsed.question.trim() : '';
  if (parsed?.done === true || question.length === 0) {
    return { done: true };
  }
  const suggestion = typeof parsed?.suggestion === 'string' ? parsed.suggestion.trim() : '';
  return { done: false, question, suggestion };
}

/** Строит фабрику диалогов для агентов пайплайна на базе клиента и конфигурации.
 *  `onUsage` — учёт токенов каждого обращения; `onToolCall` — печать вызовов инструментов. */
export function makeConversationFactory(
  client: ChatCompletionClient,
  config: AppConfig,
  disableThinking: boolean,
  temperature: number,
  onUsage?: (usage: Usage) => void,
  onToolCall?: (name: string, args: Record<string, unknown>) => void,
): ConversationFactory {
  return (systemPrompt, limits, temperatureOverride, tools) =>
    new Conversation(client, {
      systemPrompt,
      // Этап может задать свою температуру (напр. проверяющий — низкую); иначе общая.
      temperature: temperatureOverride ?? temperature,
      contextTokens: config.contextTokens,
      requestTimeoutMs: config.requestTimeoutMs,
      disableThinking,
      // Потолок генерации этапов из конфига (если задан); явный limits имеет приоритет.
      limits:
        config.stageMaxTokens === undefined
          ? limits
          : { ...limits, maxTokens: limits?.maxTokens ?? config.stageMaxTokens },
      onUsage,
      tools,
      onToolCall,
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
  /** Глобальные инварианты для жёсткого контроля решающих агентов; пусто — контроль выключен. */
  invariants?: () => string[];
  /**
   * Конфиг команды агентов на этап (потолок ролей + конкурентность). Не задан —
   * многоагентность выключена (однопроходный режим).
   */
  teamConfig?: { maxAgents: number; concurrency: number };
  /** Инструменты (MCP) для планировщика и исполнителя; не задан — без инструментов. */
  tools?: ToolSet;
  /**
   * Структурированный вывод этапов по JSON-схеме (`LLM_STRUCTURED_OUTPUTS=1`).
   * Не задан/false — прежний путь, безопасный для z.ai/GLM.
   */
  structuredOutputs?: boolean;
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

  /**
   * Записывает нарратив прогона (этапы/уведомления) в транскрипт основной сессии как
   * реплику АССИСТЕНТА. Никогда не 'user': иначе содержимое прогона (ответы на уточнения,
   * заголовок задачи) утекает в консолидацию ГЛОБАЛЬНОГО профиля как «предпочтения
   * пользователя» — а это специфика задачи, не устойчивые черты.
   */
  private record(content: string): void {
    this.deps.recordToSession?.('assistant', content);
  }

  /** Блок инвариантов для контекста агентов пайплайна (или пусто, если их нет). */
  private invariantsBlock(): string {
    const list = this.deps.invariants?.() ?? [];
    return list.length === 0
      ? ''
      : 'ИНВАРИАНТЫ (АБСОЛЮТНЫЙ приоритет над требованиями задачи и пожеланиями ' +
          'пользователя; при конфликте следуй инвариантам, нарушающее требование игнорируй; ' +
          `не нарушать и не предлагать нарушающее):\n${list.map(item => `- ${item}`).join('\n')}\n\n`;
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
    this.record(`Запуск задачи по этапам: «${task.title}»`);
    await this.drive(run); // первый этап пайплайна — сбор требований
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
    this.record(`Продолжение прогона «${run.title}» с этапа «${stageLabel(run.stage)}»`);
    await this.drive(run); // продолжение — пайплайн возобновится с сохранённого этапа
  }

  /**
   * Адаптивный сбор требований (этап requirements): аналитик ведёт диалог ПО ОДНОМУ
   * вопросу, выбирая следующий с учётом прошлых ответов и (если есть) замечаний
   * проверки, и предлагает ответ по умолчанию. Ответы пишутся в детали задачи и в
   * транскрипт. Пустой ответ принимает предложение аналитика; слово-стоп завершает
   * опрос; страховочный лимит вопросов и signal тоже останавливают. Сбой аналитика не
   * валит прогон. Возвращает собранные пункты для артефакта этапа.
   */
  private async gatherRequirements(
    title: string,
    issues: string[],
    cycle: number,
    signal: AbortSignal,
  ): Promise<{ collected: string[] }> {
    const conversation = this.deps.makeConversation(
      CLARIFIER_SYSTEM,
      undefined,
      CLARIFIER_TEMPERATURE,
    );
    const context = this.deps.taskBridge.memoryContext();
    // Инварианты — первыми: аналитик не должен предлагать нарушающие их варианты.
    const prefix = this.invariantsBlock() + (context ? `${context}\n\n` : '');
    const issuesBlock =
      issues.length > 0
        ? `\n\nЗамечания прошлой проверки (учти их в вопросах):\n${issues.join('\n')}`
        : '';
    const collected: string[] = [];
    let headerShown = false;
    let prompt =
      `${prefix}Задача: ${title}${issuesBlock}\n\n` +
      'Задай первый уточняющий вопрос или верни {"done": true}, если уточнять нечего.';
    for (let asked = 0; asked < MAX_CLARIFIER_QUESTIONS; asked++) {
      if (signal.aborted) break; // опрос прерван пользователем
      let step: ClarifierStep;
      try {
        const result = await conversation.ask(prompt);
        step = parseClarifierStep(result.content);
      } catch (error) {
        this.write(`[уточнение пропущено] ${describeError(error)}`); // не валим прогон
        break;
      }
      if (step.done || signal.aborted) break;
      if (!headerShown) {
        // Заголовок печатаем лениво — только когда есть хотя бы один вопрос.
        this.write(
          cycle > 0 ? `▸ уточнение требований (повтор, цикл ${cycle})…` : '▸ уточнение требований…',
        );
        headerShown = true;
      }
      const hint = step.suggestion
        ? ` (предлагаемый ответ: ${step.suggestion}; Enter — принять)`
        : '';
      const raw = (await this.deps.ask(`❓ ${step.question}${hint}\n   ответ: `)).trim();
      if (STOP_WORDS.has(raw.toLowerCase())) break; // ручной стоп
      const answer = raw === '' ? step.suggestion : raw; // пустой ответ — принимаем предложение
      if (answer) {
        // Ответ идёт в память ЗАДАЧИ (детали) и в собранные требования (артефакт этапа
        // печатается и пишется в транскрипт). В транскрипт как отдельную реплику НЕ
        // дублируем — иначе утечёт в консолидацию профиля как «предпочтение пользователя».
        this.deps.taskBridge.addDetail(`Требование: ${step.question} → ${answer}`);
        collected.push(`${step.question} → ${answer}`);
      }
      prompt =
        `Ответ пользователя: ${answer || '(без ответа)'}\n\n` +
        'Задай следующий вопрос или верни {"done": true}, если требований достаточно.';
    }
    if (collected.length > 0) {
      this.write('Требования собраны и записаны в задачу.');
    }
    return { collected };
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
    this.active.retries = 0; // правка — новый заход, сбрасываем счётчик проверок реализации
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
   * Прогоняет пайплайн с хуками печати/подтверждения/сбора требований; ловит паузу и
   * ошибки. Сбор требований — этап пайплайна (хук gatherRequirements), не пред-шаг.
   */
  private async drive(run: TaskRun): Promise<void> {
    this.pause = new AbortController();
    const signal = this.pause.signal;
    try {
      const result = await runPipeline(run, {
        store: this.deps.store,
        makeConversation: this.deps.makeConversation,
        signal,
        // Провайдер: инварианты + свежие требования (дописанные на этапе requirements) —
        // видны планированию/выполнению, чтобы агенты не нарушали ограничения изначально.
        memoryContext: () => this.invariantsBlock() + this.deps.taskBridge.memoryContext(),
        invariants: this.deps.invariants,
        teamConfig: this.deps.teamConfig,
        tools: this.deps.tools,
        structuredOutputs: this.deps.structuredOutputs,
        hooks: {
          // Печатаем решение оркестратора только когда подобрана команда (>1 роли).
          onTeam: (stage, team) => {
            if (team.roles.length > 1) {
              this.write(formatTeam(stage, team));
            }
          },
          onInvariantViolation: ({ stage, violations, fatal }) =>
            this.write(
              fatal
                ? `⛔ Инварианты нарушены и не исправлены на этапе «${stageLabel(stage)}»:\n` +
                    `${violations.join('\n')}\nПрогон на паузе — /run edit или /run abort.`
                : `↻ контролёр: нарушены инварианты — перегенерация:\n${violations.join('\n')}`,
            ),
          onStageRepair: (from, to) =>
            this.write(
              `↩ состояние не согласовано (этап «${stageLabel(from)}» без нужных артефактов) — ` +
                `возвращён к «${stageLabel(to)}», перепрыгнуть этап нельзя`,
            ),
          gatherRequirements: ({ issues, cycle }) =>
            this.gatherRequirements(run.title, issues, cycle, signal),
          onStageStart: stage => this.write(`▸ ${stageLabel(stage)}…`),
          onArtifact: (stage, artifacts) => {
            // Полный читаемый результат этапа — в консоль и в транскрипт сессии.
            const result = formatStageResult(stage, artifacts);
            this.write(result);
            this.record(`[${stageLabel(stage)}]\n${result}`);
          },
          onRetry: (attempt, reason) =>
            this.write(
              `↺ возврат в выполнение (${reason === 'verification' ? 'проверка не пройдена' : 'не подтверждено'}), попытка ${attempt}`,
            ),
          onRegather: cycle =>
            this.write(
              `↺ лимит проверок (${run.maxRetries}) исчерпан — возврат к сбору требований ` +
                `(цикл ${cycle}/${run.maxRequirementCycles}), счётчик сброшен`,
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

  /** Печатает пояснение к паузе прогона (исчерпание лимитов или пользовательская пауза). */
  private reportPaused(run: TaskRun): void {
    if (run.stage === 'verification' && run.requirementCycles >= run.maxRequirementCycles) {
      this.write(
        `⏸ Исчерпан лимит циклов сбора требований (${run.maxRequirementCycles}). ` +
          'Внесите правку (/run edit) и продолжите (/run continue) либо завершите (/run abort).',
      );
      return;
    }
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
