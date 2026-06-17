import * as readline from 'node:readline/promises';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import {
  loadConfig,
  ChatCompletionClient,
  FileSessionStore,
  FileProfileStore,
  FileTaskStore,
  createSession,
  createTask,
  emptyProfile,
  summarizeTask,
} from '../../core/src/index.ts';
import type {
  AppConfig,
  ChatMessage,
  CompletionResult,
  GenerationLimits,
  Profile,
  ProfileStore,
  ResponseFormat,
  Session,
  SessionStore,
  SessionSummary,
  Task,
  TaskStore,
  TaskSummary,
  Usage,
} from '../../core/src/index.ts';

/** Метка ответа модели в интерактивном режиме. */
const ASSISTANT_LABEL = 'Ассистент';

/**
 * Проверяет температуру: конечное неотрицательное число; возвращает число или
 * null при ошибке. Верхнюю границу не навязываем — она зависит от провайдера
 * (z.ai/GLM ≈ 0–1, OpenAI ≈ 0–2), и провайдер сам отклонит слишком большое.
 */
export function validTemperature(value: string): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** Запускает один запрос с таймаутом и ограничениями; возвращает ответ и usage. */
export async function askModel(
  client: ChatCompletionClient,
  messages: ChatMessage[],
  requestTimeoutMs: number,
  limits: GenerationLimits,
  disableThinking: boolean,
  temperature: number,
): Promise<CompletionResult> {
  // AbortSignal.timeout даёт при срабатывании TimeoutError — его легко
  // отличить от AbortError, который возникает при отмене пользователем.
  const signal = AbortSignal.timeout(requestTimeoutMs);
  return client.completeWithUsage(messages, { signal, disableThinking, temperature, ...limits });
}

/**
 * Дополняет системный промпт инструкцией о формате — мягкая деградация для
 * провайдеров, которые игнорируют строгий json_schema: схема дублируется
 * текстом, чтобы модель всё равно постаралась вернуть нужный JSON.
 */
export function augmentSystemPrompt(systemPrompt: string, limits: GenerationLimits): string {
  const format = limits.responseFormat;
  if (format?.type === 'json_schema') {
    const schemaText = JSON.stringify(format.json_schema.schema, null, 2);
    return (
      `${systemPrompt}\n\n` +
      'Отвечай строго в виде JSON, соответствующего этой JSON Schema, ' +
      'без markdown и без пояснений:\n' +
      schemaText
    );
  }
  return systemPrompt;
}

/** Каталог хранения сессий: из LLM_SESSION_DIR или `~/.llm-cli/sessions`. */
export function sessionDirectory(): string {
  return process.env.LLM_SESSION_DIR?.trim() || join(homedir(), '.llm-cli', 'sessions');
}

/** Базовый каталог памяти (рядом с сессиями): родитель каталога сессий. */
function memoryBaseDir(): string {
  return dirname(sessionDirectory());
}

/** Путь к файлу долговременного профиля пользователя. */
export function profilePath(): string {
  return join(memoryBaseDir(), 'profile.json');
}

/** Каталог хранения задач. */
export function tasksDirectory(): string {
  return join(memoryBaseDir(), 'tasks');
}

/**
 * Готовит сессию для интерактивного режима: новую (по умолчанию) или
 * восстановленную. resume='last' берёт последнюю, иначе — по id; при fork —
 * ветвление в новую сессию с копией сообщений (оригинал не трогаем).
 * Восстановленная сессия используется как есть (система заморожена), новая —
 * с системным сообщением из текущего конфига.
 */
/** Имя ветки по умолчанию — точка возврата к исходному диалогу. */
const DEFAULT_BRANCH_LABEL = 'main';

/** Новая сессия (ветка «main») с системным сообщением из текущего конфига. */
export function newSession(config: AppConfig, limits: GenerationLimits): Session {
  return createSession(
    config.model,
    [{ role: 'system', content: augmentSystemPrompt(config.systemPrompt, limits) }],
    undefined,
    undefined,
    DEFAULT_BRANCH_LABEL,
  );
}

/** Занято ли имя ветки среди сохранённых сессий. */
function branchNameTaken(store: SessionStore, name: string): boolean {
  return store.list().some(summary => summary.label === name);
}

/** Находит ветку по имени (label), а если не нашлось — по id. */
function resolveBranch(store: SessionStore, nameOrId: string): Session | null {
  const byLabel = store.list().find(summary => summary.label === nameOrId);
  return byLabel ? store.load(byLabel.id) : store.load(nameOrId);
}

/**
 * Готовит сессию для старта: продолжение существующей ветки (`switchTo` — имя/id
 * или 'last') и/или ответвление в новую именованную ветку (`branchName`). Без
 * хранилища или без обоих параметров — новая ветка «main». Имя для ветвления
 * должно быть свободно; несуществующая ветка для switchTo — ошибка.
 */
export function resolveSession(
  store: SessionStore | null,
  config: AppConfig,
  limits: GenerationLimits,
  switchTo: string | undefined,
  branchName: string | undefined,
): Session {
  if (store === null || (switchTo === undefined && branchName === undefined)) {
    return newSession(config, limits);
  }

  // База: целевая ветка (--switch имя/id/last) либо последняя по времени.
  let base: Session | null;
  if (switchTo !== undefined) {
    base = switchTo === 'last' ? store.latest() : resolveBranch(store, switchTo);
    if (base === null && switchTo !== 'last') {
      throw new Error(`Ветка не найдена: ${switchTo}`);
    }
  } else {
    base = store.latest();
  }

  if (branchName !== undefined) {
    if (branchNameTaken(store, branchName)) {
      throw new Error(`Ветка «${branchName}» уже существует`);
    }
    const model = base?.model ?? config.model;
    const messages = base ? [...base.messages] : newSession(config, limits).messages;
    return createSession(model, messages, undefined, undefined, branchName);
  }
  return base ?? newSession(config, limits);
}

/** Сколько символов считаем за один токен в грубой оценке (провайдер-агностично). */
const CHARS_PER_TOKEN = 3;
/** Накладные токены на одно сообщение (роль и служебная разметка). */
const MESSAGE_OVERHEAD_TOKENS = 4;
/** Сколько токенов резервируем под ответ, если --max-tokens не задан. */
const DEFAULT_RESPONSE_RESERVE_TOKENS = 1024;
/** Нижняя граница бюджета истории, чтобы он не оказался нулём/отрицательным. */
const MIN_HISTORY_BUDGET_TOKENS = 256;
/** Сколько последних реплик стратегия summary держит дословно по умолчанию. */
const DEFAULT_KEEP_RECENT = 6;

/**
 * Грубая оценка числа токенов в тексте. Точного токенизатора нет (приложение
 * провайдер-агностично), поэтому считаем консервативно — лучше переоценить
 * размер и обрезать чуть больше, чем переполнить контекст модели.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Оценка токенов одного сообщения: содержимое плюс накладные расходы. */
function messageTokens(message: ChatMessage): number {
  return estimateTokens(message.content) + MESSAGE_OVERHEAD_TOKENS;
}

/** Приблизительный размер всей истории сессии в токенах. */
export function historyTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + messageTokens(message), 0);
}

/** Стоимость запроса в долларах по тарифам конфига ($/1M токенов). */
export function requestCostUsd(usage: Usage, config: AppConfig): number {
  return (
    (usage.prompt_tokens * config.priceInputPer1M +
      usage.completion_tokens * config.priceOutputPer1M) /
    1_000_000
  );
}

/**
 * Строка статистики под ответом: токены входа/выхода запроса, размер истории
 * сессии и стоимость в $ и ₽. Если usage не пришёл — «н/д»; если тарифы не
 * заданы — подсказка задать LLM_PRICE_*.
 */
export function formatUsageStats(
  usage: Usage | undefined,
  historyTokenCount: number,
  config: AppConfig,
  label?: string,
): string {
  const prefix = label ? `${label} · ` : '';
  if (usage === undefined) {
    return `[${prefix}токены: н/д · история ~${historyTokenCount}]`;
  }
  const hasPricing = config.priceInputPer1M > 0 || config.priceOutputPer1M > 0;
  const usd = requestCostUsd(usage, config);
  const cost = hasPricing
    ? ` · ≈ $${usd.toFixed(6)} / ${(usd * config.usdToRub).toFixed(4)} ₽`
    : ' · цена: задайте LLM_PRICE_INPUT_PER_1M / LLM_PRICE_OUTPUT_PER_1M';
  return (
    `[${prefix}вход ${usage.prompt_tokens} · выход ${usage.completion_tokens} · ` +
    `история ~${historyTokenCount}${cost}]`
  );
}

/** Итоговая сводка за сессию: суммарные токены и стоимость в $ и ₽. */
export function formatSessionTotals(totals: Usage, config: AppConfig): string {
  const hasPricing = config.priceInputPer1M > 0 || config.priceOutputPer1M > 0;
  const usd = requestCostUsd(totals, config);
  const cost = hasPricing
    ? ` · ≈ $${usd.toFixed(6)} / ${(usd * config.usdToRub).toFixed(4)} ₽`
    : '';
  return (
    `Итого за сессию: вход ${totals.prompt_tokens} · выход ${totals.completion_tokens} · ` +
    `всего ${totals.total_tokens}${cost}`
  );
}

/**
 * Бюджет истории в токенах: контекст модели за вычетом резерва под ответ
 * (явный --max-tokens или дефолтный резерв), но не ниже минимума.
 */
export function historyBudgetTokens(contextTokens: number, maxTokens?: number): number {
  const responseReserve = maxTokens ?? DEFAULT_RESPONSE_RESERVE_TOKENS;
  return Math.max(contextTokens - responseReserve, MIN_HISTORY_BUDGET_TOKENS);
}

/**
 * Скользящее окно истории по токенам: всегда сохраняет системные сообщения и
 * оставляет самые свежие реплики, пока укладывается в бюджет. Самое последнее
 * сообщение сохраняется всегда — даже если оно одно превышает бюджет.
 */
export function trimHistoryToBudget(history: ChatMessage[], budgetTokens: number): ChatMessage[] {
  const systemMessages = history.filter(message => message.role === 'system');
  const conversation = history.filter(message => message.role !== 'system');

  let usedTokens = systemMessages.reduce((sum, message) => sum + messageTokens(message), 0);
  const keptInReverse: ChatMessage[] = [];
  for (let index = conversation.length - 1; index >= 0; index--) {
    const cost = messageTokens(conversation[index]);
    if (keptInReverse.length > 0 && usedTokens + cost > budgetTokens) {
      break;
    }
    keptInReverse.push(conversation[index]);
    usedTokens += cost;
  }
  keptInReverse.reverse();
  return [...systemMessages, ...keptInReverse];
}

/** Стратегия управления памятью диалога: окно, сжатие или блок фактов. */
export type MemoryKind = 'window' | 'summary' | 'facts';

/** Готовит сообщения для запроса к модели из полного транскрипта сессии. */
export interface MemoryStrategy {
  prepare(
    messages: ChatMessage[],
    onCompression?: (usage: Usage | undefined) => void,
  ): Promise<ChatMessage[]>;
  /** Сбрасывает состояние при смене сессии (/reset, /resume, /fork). */
  reset(): void;
}

/** Стратегия скользящего окна (по умолчанию): обрезка по бюджету, без вызовов модели. */
class WindowStrategy implements MemoryStrategy {
  private readonly budget: number;
  constructor(budget: number) {
    this.budget = budget;
  }
  async prepare(messages: ChatMessage[]): Promise<ChatMessage[]> {
    return trimHistoryToBudget(messages, this.budget);
  }
  reset(): void {}
}

/**
 * Потолок длины блока памяти (резюме или фактов), который генерирует модель:
 * компромисс между сохранностью данных и экономией. 256 было слишком агрессивно
 * (сильно резало факты), budget/4 — слишком дорого; 512 — баланс.
 */
const MEMORY_BLOCK_MAX_TOKENS = 512;

/**
 * Стратегия сжатия: последние N реплик хранятся дословно, всё, что старше,
 * сворачивается в системное резюме (отдельным вызовом модели). При сбое сжатия
 * на этот ход откатывается к окну.
 */
class SummaryStrategy implements MemoryStrategy {
  private readonly budget: number;
  private readonly recentCount: number;
  private readonly client: ChatCompletionClient;
  private readonly requestTimeoutMs: number;
  private summary = '';
  private summarizedCount = 0;

  constructor(
    budget: number,
    recentCount: number,
    client: ChatCompletionClient,
    requestTimeoutMs: number,
  ) {
    this.budget = budget;
    this.recentCount = recentCount;
    this.client = client;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  reset(): void {
    this.summary = '';
    this.summarizedCount = 0;
  }

  private summaryMessage(): ChatMessage | null {
    return this.summary
      ? { role: 'system', content: `Краткое содержание более раннего диалога: ${this.summary}` }
      : null;
  }

  /** Сворачивает реплики (с учётом прежнего резюме) в обновлённое резюме. */
  private async fold(spill: ChatMessage[]): Promise<CompletionResult> {
    const dialogue = spill
      .map(
        message =>
          `${message.role === 'assistant' ? 'Ассистент' : 'Пользователь'}: ${message.content}`,
      )
      .join('\n');
    const instruction =
      (this.summary
        ? `Есть краткое содержание диалога:\n${this.summary}\n\nОбнови его, добавив реплики ниже. `
        : 'Сожми этот фрагмент диалога в краткое содержание. ') +
      'Сохрани факты, решения, имена и числа, без воды. Верни только краткое содержание:\n' +
      dialogue;
    const result = await this.client.completeWithUsage([{ role: 'user', content: instruction }], {
      signal: AbortSignal.timeout(this.requestTimeoutMs),
      disableThinking: true,
      maxTokens: MEMORY_BLOCK_MAX_TOKENS,
    });
    this.summary = result.content.trim();
    return result;
  }

  async prepare(
    messages: ChatMessage[],
    onCompression?: (usage: Usage | undefined) => void,
  ): Promise<ChatMessage[]> {
    const systemMessage = messages[0];
    const conversation = messages.slice(1);
    // Дословно держим последние N реплик; всё, что старше, — в резюме.
    const keepFrom = Math.max(0, conversation.length - this.recentCount);
    try {
      const toFold = conversation.slice(this.summarizedCount, keepFrom);
      if (toFold.length > 0) {
        const result = await this.fold(toFold);
        this.summarizedCount = keepFrom;
        onCompression?.(result.usage);
      }
      const kept = conversation.slice(keepFrom);
      const summaryMsg = this.summaryMessage();
      return [systemMessage, ...(summaryMsg ? [summaryMsg] : []), ...kept];
    } catch {
      // Сжатие не удалось — мягко откатываемся к окну на этот ход.
      return trimHistoryToBudget(messages, this.budget);
    }
  }
}

/**
 * Стратегия «липких фактов»: отдельный блок «ключ: значение» (цель, ограничения,
 * предпочтения, решения, договорённости) обновляется моделью на каждом ходу и
 * отправляется вместе с последними N репликами. В отличие от summary, факты
 * обновляются всегда (не только при переполнении) и хранят структурированные
 * данные, а не пересказ. При сбое обновления оставляем прежние факты.
 */
class FactsStrategy implements MemoryStrategy {
  private readonly budget: number;
  private readonly recentCount: number;
  private readonly client: ChatCompletionClient;
  private readonly requestTimeoutMs: number;
  private facts = '';
  private factedThrough = 0;

  constructor(
    budget: number,
    recentCount: number,
    client: ChatCompletionClient,
    requestTimeoutMs: number,
  ) {
    this.budget = budget;
    this.recentCount = recentCount;
    this.client = client;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  reset(): void {
    this.facts = '';
    this.factedThrough = 0;
  }

  private factsMessage(): ChatMessage | null {
    return this.facts
      ? { role: 'system', content: `Известные факты о диалоге:\n${this.facts}` }
      : null;
  }

  /** Обновляет блок фактов с учётом новых реплик (с приоритетом слов пользователя). */
  private async update(spill: ChatMessage[]): Promise<CompletionResult> {
    const dialogue = spill
      .map(
        message =>
          `${message.role === 'assistant' ? 'Ассистент' : 'Пользователь'}: ${message.content}`,
      )
      .join('\n');
    const instruction =
      (this.facts
        ? `Текущие факты:\n${this.facts}\n\nОбнови их с учётом новых сообщений ниже. `
        : 'Извлеки ключевые факты из диалога ниже. ') +
      'Веди компактный список «ключ: значение»: цель, ограничения, предпочтения, ' +
      'решения, договорённости. Данные из реплик пользователя приоритетнее данных ' +
      'из ответов ассистента — при противоречии оставляй версию пользователя. ' +
      'Обновляй изменившееся, убирай устаревшее, без воды. Верни только список:\n' +
      dialogue;
    const result = await this.client.completeWithUsage([{ role: 'user', content: instruction }], {
      signal: AbortSignal.timeout(this.requestTimeoutMs),
      disableThinking: true,
      maxTokens: MEMORY_BLOCK_MAX_TOKENS,
    });
    this.facts = result.content.trim();
    return result;
  }

  async prepare(
    messages: ChatMessage[],
    onCompression?: (usage: Usage | undefined) => void,
  ): Promise<ChatMessage[]> {
    const systemMessage = messages[0];
    const conversation = messages.slice(1);
    // Новые реплики с прошлого раза: предыдущий ответ ассистента + новый вопрос.
    const newMessages = conversation.slice(this.factedThrough);
    if (newMessages.length > 0) {
      try {
        const result = await this.update(newMessages);
        this.factedThrough = conversation.length;
        onCompression?.(result.usage);
      } catch {
        // Обновление не удалось — оставляем прежние факты, повторим в следующий ход.
      }
    }
    // Дословно держим последние N реплик; старое представлено блоком фактов.
    const keepFrom = Math.max(0, conversation.length - this.recentCount);
    const kept = conversation.slice(keepFrom);
    const factsMsg = this.factsMessage();
    const assembled = [systemMessage, ...(factsMsg ? [factsMsg] : []), ...kept];
    // Подстраховка: если факты + последние N всё же не влезают — обрезаем по окну.
    return historyTokens(assembled) > this.budget
      ? trimHistoryToBudget(assembled, this.budget)
      : assembled;
  }
}

/**
 * Создаёт стратегию памяти. Клиент сжатия инъектируется отдельно — это шов,
 * чтобы в будущем назначить более дешёвую/специализированную модель.
 */
export function createMemoryStrategy(
  kind: MemoryKind,
  budget: number,
  recentCount: number,
  summaryClient: ChatCompletionClient,
  requestTimeoutMs: number,
): MemoryStrategy {
  switch (kind) {
    case 'summary':
      return new SummaryStrategy(budget, recentCount, summaryClient, requestTimeoutMs);
    case 'facts':
      return new FactsStrategy(budget, recentCount, summaryClient, requestTimeoutMs);
    default:
      return new WindowStrategy(budget);
  }
}

/** Ограничивает число диапазоном [min, max]. */
function clampTokens(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Бюджеты слоёв памяти: профиль, задача и остаток под короткую память. */
export interface LayerBudgets {
  profile: number;
  task: number;
  short: number;
}

/**
 * Делит бюджет истории между слоями. Профиль и задача — доли от контекста модели
 * (с потолками), чтобы крупнее окно — крупнее память; флаги-переопределения важнее.
 * Слои не могут занять больше половины бюджета — остаток гарантирован короткой памяти.
 */
export function layerBudgets(
  historyBudget: number,
  contextTokens: number,
  profileOverride?: number,
  taskOverride?: number,
): LayerBudgets {
  let profile = profileOverride ?? clampTokens(Math.round(contextTokens / 32), 256, 1536);
  let task = taskOverride ?? clampTokens(Math.round(contextTokens / 16), 512, 3072);
  const layersCap = Math.floor(historyBudget / 2);
  if (profile + task > layersCap) {
    const scale = layersCap / (profile + task);
    profile = Math.floor(profile * scale);
    task = Math.floor(task * scale);
  }
  const short = Math.max(MIN_HISTORY_BUDGET_TOKENS, historyBudget - profile - task);
  return { profile, task, short };
}

/** Директива персонализации: велит модели применять профиль и держаться задачи. */
const PERSONALIZATION_DIRECTIVE =
  'Учитывай профиль пользователя и текущую задачу ниже. Отвечай конкретно под его ' +
  'контекст, стек и предпочтения, держись задачи. Избегай общих вступлений и оговорок, ' +
  'если пользователь их не просит. Профиль — это дефолты; свежая реплика пользователя важнее.';

/** Обрезает текст до бюджета токенов (грубо, по символам), добавляя многоточие. */
function capToBudget(text: string, budgetTokens: number): string {
  if (estimateTokens(text) <= budgetTokens) {
    return text;
  }
  return text.slice(0, Math.max(0, budgetTokens * CHARS_PER_TOKEN - 1)) + '…';
}

/** Параметры менеджера слоистой памяти. */
export interface MemoryManagerOptions {
  /** Включена ли слоистая память (--no-memory выключает). */
  enabled: boolean;
  /** Короткая память (окно/сжатие/факты) — работает внутри менеджера. */
  strategy: MemoryStrategy;
  budgets: LayerBudgets;
  client: ChatCompletionClient;
  requestTimeoutMs: number;
  /** Долговременный профиль (загружен заранее). */
  profile: Profile;
  /** Хранилища; null — режим «в памяти, без записи на диск» (--ephemeral). */
  profileStore: ProfileStore | null;
  taskStore: TaskStore | null;
}

/** Отчёт о записи в память — что и в какой слой записано на этом шаге. */
export interface MemoryWriteReport {
  usage: Usage | undefined;
  /** Имя задачи, если её факты обновлены (иначе null). */
  taskTitle: string | null;
  /** Сколько фактов в задаче после обновления. */
  taskFactCount: number;
  /** Какие пункты добавлены в профиль на этом шаге. */
  profileAdded: string[];
  /** Число пунктов после консолидации профиля (иначе null — это не консолидация). */
  consolidated: number | null;
}

/**
 * Менеджер слоистой памяти: поверх короткой стратегии подмешивает в запрос
 * долговременный профиль пользователя и текущую задачу, обновляет их по ходу
 * диалога (извлечение фактов задачи + явные предпочтения) и консолидирует
 * профиль в конце сессии. Делает ответы персонализированными и нацеленными на
 * задачу. Хранилища = null — всё держим в памяти, на диск не пишем (--ephemeral).
 */
export class MemoryManager {
  readonly enabled: boolean;
  private readonly strategy: MemoryStrategy;
  private readonly budgets: LayerBudgets;
  private readonly client: ChatCompletionClient;
  private readonly requestTimeoutMs: number;
  private readonly profileStore: ProfileStore | null;
  private readonly taskStore: TaskStore | null;
  private profile: Profile;
  private task: Task | null = null;
  // Индекс задач этого процесса (нужен для in-memory режима без хранилища).
  private readonly tasks = new Map<string, Task>();
  private extractedThrough = 0;
  // Предложенное (но ещё не подтверждённое) имя новой задачи.
  private proposal: string | null = null;
  // Имена предложений, от которых пользователь уже отказался (не предлагаем снова).
  private readonly declined = new Set<string>();

  constructor(options: MemoryManagerOptions) {
    this.enabled = options.enabled;
    this.strategy = options.strategy;
    this.budgets = options.budgets;
    this.client = options.client;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.profile = options.profile;
    this.profileStore = options.profileStore;
    this.taskStore = options.taskStore;
  }

  /** Текущая активная задача (или null). */
  currentTask(): Task | null {
    return this.task;
  }

  /** Пункты профиля пользователя. */
  profileEntries(): string[] {
    return this.profile.entries.map(entry => entry.text);
  }

  /** Сбрасывает состояние короткой памяти при смене ветки/сессии. */
  reset(): void {
    this.strategy.reset();
    this.extractedThrough = 0;
    this.proposal = null;
  }

  /** Забирает предложение новой задачи (если есть), очищая его. */
  takeProposal(): string | null {
    const proposed = this.proposal;
    this.proposal = null;
    return proposed;
  }

  /** Помечает предложение отклонённым — больше не предлагаем эту задачу. */
  declineProposal(title: string): void {
    this.declined.add(title);
  }

  /** Сохраняет задачу в хранилище (если есть) и в индекс процесса. */
  private persistTask(task: Task): void {
    this.tasks.set(task.id, task);
    this.taskStore?.save(task);
  }

  /** Создаёт новую активную задачу и делает её текущей. */
  setTask(title: string): Task {
    const task = createTask(title);
    this.task = task;
    this.proposal = null; // задача выбрана — снимаем висящее предложение
    this.persistTask(task);
    return task;
  }

  /** Список задач (из хранилища или из памяти процесса), свежие первыми. */
  listTasks(): TaskSummary[] {
    if (this.taskStore !== null) {
      return this.taskStore.list();
    }
    return [...this.tasks.values()]
      .map(summarizeTask)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Загружает задачу по id из хранилища или индекса процесса. */
  private loadById(id: string): Task | null {
    return this.taskStore?.load(id) ?? this.tasks.get(id) ?? null;
  }

  /** Находит задачу по id или имени (id приоритетнее). */
  private findTask(idOrName: string): Task | null {
    const direct = this.loadById(idOrName);
    if (direct !== null) {
      return direct;
    }
    const match = this.listTasks().find(summary => summary.title === idOrName);
    return match ? this.loadById(match.id) : null;
  }

  /** Делает активной существующую задачу (реактивирует завершённую). */
  switchTask(idOrName: string): Task | null {
    const task = this.findTask(idOrName);
    if (task === null) {
      return null;
    }
    if (task.status === 'done') {
      task.status = 'active';
      task.updatedAt = new Date().toISOString();
      this.persistTask(task);
    }
    this.task = task;
    return task;
  }

  /**
   * Привязывает менеджер к задаче сессии по её id (при resume/ветвлении/reset).
   * Нет id — активной задачи нет (предсказуемо для новой ветки).
   */
  adopt(taskId: string | undefined): void {
    this.task = taskId === undefined ? null : this.findTask(taskId);
  }

  /** Закрывает текущую задачу (помечает done); возвращает её имя или null. */
  closeTask(): string | null {
    if (this.task === null) {
      return null;
    }
    const title = this.task.title;
    this.task.status = 'done';
    this.task.updatedAt = new Date().toISOString();
    this.persistTask(this.task);
    this.task = null;
    return title;
  }

  /** Удаляет задачу по id или имени; возвращает удалённую задачу или null. */
  deleteTask(idOrName: string): Task | null {
    const task = this.findTask(idOrName);
    if (task === null) {
      return null;
    }
    this.tasks.delete(task.id);
    this.taskStore?.delete(task.id);
    if (this.task?.id === task.id) {
      this.task = null; // удалили активную — снимаем
    }
    return task;
  }

  /** Забывает пункт профиля по номеру (1-based); возвращает текст или null. */
  forgetProfile(oneBasedIndex: number): string | null {
    const index = oneBasedIndex - 1;
    if (index < 0 || index >= this.profile.entries.length) {
      return null;
    }
    const [removed] = this.profile.entries.splice(index, 1);
    this.profile.updatedAt = new Date().toISOString();
    this.profileStore?.save(this.profile);
    return removed.text;
  }

  /** Системный блок профиля (или null, если пусто/выключено). */
  private profileBlock(): ChatMessage | null {
    if (!this.enabled || this.profile.entries.length === 0) {
      return null;
    }
    const body = capToBudget(
      this.profile.entries.map(entry => `- ${entry.text}`).join('\n'),
      this.budgets.profile,
    );
    return { role: 'system', content: `Профиль пользователя:\n${body}` };
  }

  /** Системный блок текущей задачи (или null, если задачи нет/выключено). */
  private taskBlock(): ChatMessage | null {
    if (!this.enabled || this.task === null) {
      return null;
    }
    const details =
      this.task.details.length > 0
        ? this.task.details.map(d => `- ${d}`).join('\n')
        : '(пока без деталей)';
    return {
      role: 'system',
      content: `Текущая задача: ${this.task.title}\n${capToBudget(details, this.budgets.task)}`,
    };
  }

  /** Извлекает из новых реплик факты задачи и явные предпочтения (один вызов). */
  private async extract(newMessages: ChatMessage[]): Promise<CompletionResult> {
    const dialogue = newMessages
      .map(m => `${m.role === 'assistant' ? 'Ассистент' : 'Пользователь'}: ${m.content}`)
      .join('\n');
    const taskContext =
      this.task !== null
        ? `Текущая задача: ${this.task.title}\nИзвестные факты задачи:\n${this.task.details.join('\n')}\n\n`
        : 'Активной задачи нет.\n\n';
    const profileContext =
      this.profile.entries.length > 0
        ? `Уже известно о пользователе:\n${this.profile.entries.map(e => e.text).join('\n')}\n\n`
        : '';
    const instruction =
      taskContext +
      profileContext +
      'Проанализируй новые сообщения и верни СТРОГО JSON с полями. ' +
      '"task" — обновлённый список фактов текущей задачи (цель, ограничения, решения, ' +
      'прогресс); если активной задачи нет — пустой массив. ' +
      '"user" — НОВЫЕ предпочтения, которые ПОЛЬЗОВАТЕЛЬ заявил САМ (в строках ' +
      '«Пользователь:») или явно подтвердил; НЕ бери их из предложений ассистента, ' +
      'не подтверждённых пользователем; если таких нет — пустой массив. ' +
      '"isNewTask" — true, если пользователь ставит НОВУЮ задачу/цель, отличную от ' +
      'текущей (а не уточняет её и не ведёт болтовню); иначе false. ' +
      '"proposedTitle" — краткое имя этой новой задачи (если isNewTask), иначе "". ' +
      'Без пояснений.\n\nСообщения:\n' +
      dialogue;
    return this.client.completeWithUsage([{ role: 'user', content: instruction }], {
      signal: AbortSignal.timeout(this.requestTimeoutMs),
      disableThinking: true,
      maxTokens: this.budgets.task,
      responseFormat: { type: 'json_object' },
    });
  }

  /**
   * Применяет результат извлечения к задаче и профилю (с сохранением). Возвращает,
   * что именно записано: обновлена ли задача и какие пункты добавлены в профиль.
   */
  private applyExtraction(content: string): { taskUpdated: boolean; profileAdded: string[] } {
    let parsed: { task?: unknown; user?: unknown; isNewTask?: unknown; proposedTitle?: unknown };
    try {
      parsed = JSON.parse(content);
    } catch {
      return { taskUpdated: false, profileAdded: [] }; // невалидный JSON — пропускаем ход
    }
    const now = new Date().toISOString();
    // Авто-определение новой задачи: предлагаем, если уверены, тема отличается от
    // текущей и пользователь раньше от такого имени не отказывался.
    const proposedTitle =
      typeof parsed.proposedTitle === 'string' ? parsed.proposedTitle.trim() : '';
    if (
      parsed.isNewTask === true &&
      proposedTitle.length > 0 &&
      proposedTitle !== this.task?.title &&
      !this.declined.has(proposedTitle)
    ) {
      this.proposal = proposedTitle;
    }
    let taskUpdated = false;
    if (this.task !== null && Array.isArray(parsed.task)) {
      this.task.details = parsed.task.filter((x): x is string => typeof x === 'string');
      this.task.updatedAt = now;
      this.persistTask(this.task);
      taskUpdated = true;
    }
    const profileAdded: string[] = [];
    if (Array.isArray(parsed.user)) {
      const known = new Set(this.profile.entries.map(entry => entry.text));
      for (const trait of parsed.user) {
        if (typeof trait === 'string' && trait.trim() && !known.has(trait.trim())) {
          this.profile.entries.push({ text: trait.trim(), updatedAt: now });
          known.add(trait.trim());
          profileAdded.push(trait.trim());
        }
      }
      if (profileAdded.length > 0) {
        this.profile.updatedAt = now;
        this.profileStore?.save(this.profile);
      }
    }
    return { taskUpdated, profileAdded };
  }

  /**
   * Наблюдает за новыми репликами: извлекает факты задачи и явные предпочтения,
   * детектит новую задачу (предложение можно забрать через takeProposal). Делается
   * ДО ответа модели — чтобы подтверждённая задача попала в контекст этого же хода.
   */
  async observe(
    messages: ChatMessage[],
    onExtraction?: (usage: Usage | undefined) => void,
  ): Promise<MemoryWriteReport | null> {
    if (!this.enabled) {
      return null;
    }
    const conversation = messages.slice(1);
    const newMessages = conversation.slice(this.extractedThrough);
    if (newMessages.length === 0) {
      return null;
    }
    try {
      const result = await this.extract(newMessages);
      const applied = this.applyExtraction(result.content);
      this.extractedThrough = conversation.length;
      onExtraction?.(result.usage);
      return {
        usage: result.usage,
        taskTitle: applied.taskUpdated && this.task !== null ? this.task.title : null,
        taskFactCount: this.task !== null ? this.task.details.length : 0,
        profileAdded: applied.profileAdded,
        consolidated: null,
      };
    } catch {
      // Извлечение не удалось — оставляем прежнюю память, повторим в следующий ход.
      return null;
    }
  }

  /**
   * Собирает сообщения для запроса: прогоняет короткую стратегию и подмешивает
   * блоки профиля и задачи + директиву (без обращения к модели за памятью).
   */
  async build(
    messages: ChatMessage[],
    onCompression?: (usage: Usage | undefined) => void,
  ): Promise<ChatMessage[]> {
    const shortened = await this.strategy.prepare(messages, onCompression);
    if (!this.enabled) {
      return shortened;
    }
    const system: ChatMessage = {
      role: 'system',
      content: `${shortened[0].content}\n\n${PERSONALIZATION_DIRECTIVE}`,
    };
    const blocks: ChatMessage[] = [];
    const profile = this.profileBlock();
    if (profile) blocks.push(profile);
    const task = this.taskBlock();
    if (task) blocks.push(task);
    return [system, ...blocks, ...shortened.slice(1)];
  }

  /** Наблюдение + сборка одним вызовом (наблюдение раньше сборки). */
  async prepare(
    messages: ChatMessage[],
    onCompression?: (usage: Usage | undefined) => void,
    onExtraction?: (usage: Usage | undefined) => void,
  ): Promise<ChatMessage[]> {
    await this.observe(messages, onExtraction);
    return this.build(messages, onCompression);
  }

  /** Консолидирует устойчивые черты пользователя в профиль (в конце сессии). */
  async consolidate(
    messages: ChatMessage[],
    onExtraction?: (usage: Usage | undefined) => void,
  ): Promise<MemoryWriteReport | null> {
    const conversation = messages.slice(1);
    // Профиль строим ТОЛЬКО из реплик пользователя — чтобы не впитать предложения
    // и допущения модели как «предпочтения пользователя».
    const userMessages = conversation.filter(message => message.role === 'user');
    if (!this.enabled || userMessages.length === 0) {
      return null;
    }
    const dialogue = userMessages.map(message => `Пользователь: ${message.content}`).join('\n');
    const known =
      this.profile.entries.length > 0
        ? `Текущий профиль:\n${this.profile.entries.map(e => e.text).join('\n')}\n\n`
        : '';
    const instruction =
      known +
      'Ниже — реплики ПОЛЬЗОВАТЕЛЯ. Обнови долговременный профиль из того, что ' +
      'пользователь сообщил О СЕБЕ и своих предпочтениях (стек, стиль, привычки, ' +
      'приоритеты). НЕ добавляй факты, которых пользователь сам не утверждал, и не ' +
      'выводи их из обсуждаемой задачи. Слей дубли, убери разовое. Верни ТОЛЬКО ' +
      'список, по одному факту на строку.\n\nРеплики:\n' +
      dialogue;
    try {
      const result = await this.client.completeWithUsage([{ role: 'user', content: instruction }], {
        signal: AbortSignal.timeout(this.requestTimeoutMs),
        disableThinking: true,
        maxTokens: this.budgets.profile,
      });
      const now = new Date().toISOString();
      const entries = result.content
        .split('\n')
        .map(line => line.replace(/^[-*\s]+/, '').trim())
        .filter(line => line.length > 0)
        .map(text => ({ text, updatedAt: now }));
      if (entries.length > 0) {
        this.profile = { ...this.profile, entries, updatedAt: now };
        this.profileStore?.save(this.profile);
      }
      onExtraction?.(result.usage);
      return {
        usage: result.usage,
        taskTitle: null,
        taskFactCount: 0,
        profileAdded: [],
        consolidated: entries.length,
      };
    } catch {
      // Консолидация не удалась — профиль остаётся прежним.
      return null;
    }
  }
}

/** Кадры анимации спиннера статуса. */
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * Индикатор «думает…»: крутится, пока модель не выдала видимый текст. Работает
 * только в терминале (TTY) — в пайпах/тестах это no-op, чтобы не сорить в вывод.
 */
export function createSpinner(
  output: Writable & { isTTY?: boolean },
  label: string,
): { stop: () => void } {
  if (!output.isTTY) {
    return { stop: () => {} };
  }
  let frame = 0;
  const timer = setInterval(() => {
    output.write(`\r${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]} ${label}`);
    frame++;
  }, 100);
  let stopped = false;
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      output.write('\r\x1b[K'); // вернуть каретку и очистить строку спиннера
    },
  };
}

/**
 * Стримит ответ модели, печатая видимый текст по мере поступления. Пока идут
 * только «рассуждения» (reasoning), крутится спиннер; на первом видимом токене
 * спиннер гаснет и (если задан) вызывается onFirstContent — напечатать префикс.
 * Возвращает полный текст и usage.
 */
export async function streamAnswer(
  client: ChatCompletionClient,
  messages: ChatMessage[],
  requestTimeoutMs: number,
  limits: GenerationLimits,
  disableThinking: boolean,
  temperature: number,
  output: Writable,
  onFirstContent?: () => void,
): Promise<CompletionResult> {
  // В потоковом режиме таймаут — по простою (нет новых данных), а не по общей
  // длительности: длинный, но «живой» ответ не обрывается на полуслове.
  const spinner = createSpinner(output, 'думает…');
  let started = false;
  try {
    return await client.streamWithUsage(
      messages,
      { idleTimeoutMs: requestTimeoutMs, disableThinking, temperature, ...limits },
      delta => {
        if (delta.content) {
          if (!started) {
            spinner.stop();
            onFirstContent?.();
            started = true;
          }
          output.write(delta.content);
        }
        // delta.reasoning не печатаем — спиннер продолжает крутиться.
      },
    );
  } finally {
    spinner.stop(); // на случай ошибки или ответа без видимого текста
  }
}

/** Режим одного запроса: промпт передан аргументами командной строки. */
export async function runOnce(
  client: ChatCompletionClient,
  config: AppConfig,
  prompt: string,
  limits: GenerationLimits,
  disableThinking: boolean,
  temperature: number,
  stream: boolean,
  output: Writable,
): Promise<void> {
  const messages: ChatMessage[] = [
    { role: 'system', content: augmentSystemPrompt(config.systemPrompt, limits) },
    { role: 'user', content: prompt },
  ];
  if (stream) {
    await streamAnswer(
      client,
      messages,
      config.requestTimeoutMs,
      limits,
      disableThinking,
      temperature,
      output,
    );
    output.write('\n');
  } else {
    const { content } = await askModel(
      client,
      messages,
      config.requestTimeoutMs,
      limits,
      disableThinking,
      temperature,
    );
    output.write(content + '\n');
  }
}

/** Сообщение, когда сессионные команды вызваны при отключённом хранилище. */
const EPHEMERAL_NOTICE = 'Хранилище сессий отключено (--ephemeral).\n\n';

/** Сообщение, когда команды памяти вызваны при выключенной слоистой памяти. */
const MEMORY_OFF_NOTICE = 'Слоистая память выключена (--no-memory).\n\n';

/** Параметры слоистой памяти для интерактивного режима. */
export interface MemorySettings {
  /** Включена ли слоистая память (профиль + задача). */
  enabled: boolean;
  /** Хранилища; null — в памяти на сессию, без записи на диск (--ephemeral). */
  profileStore: ProfileStore | null;
  taskStore: TaskStore | null;
  /** Переопределение размеров слоёв (иначе — эвристика от контекста). */
  profileTokens?: number;
  taskTokens?: number;
  /** Стартовая задача (из флага --task). */
  initialTaskTitle?: string;
}

/** Форматирует список задач для команды /tasks. */
export function formatTaskList(summaries: TaskSummary[]): string {
  if (summaries.length === 0) {
    return 'Задач пока нет.\n\n';
  }
  const lines = summaries.map(summary => {
    const mark = summary.status === 'done' ? '✓' : '•';
    return `  ${mark} ${summary.title}  (${summary.id})  фактов: ${summary.detailCount}`;
  });
  return `Задачи:\n${lines.join('\n')}\n\n`;
}

/** Форматирует текущую задачу (с деталями) для команды /task. */
export function formatCurrentTask(task: Task | null): string {
  if (task === null) {
    return 'Активной задачи нет. Задать: /task <описание>\n\n';
  }
  const details =
    task.details.length > 0
      ? task.details.map(detail => `  - ${detail}`).join('\n')
      : '  (пока без деталей)';
  return `Текущая задача: ${task.title}\n${details}\n\n`;
}

/** Форматирует профиль пользователя (нумерованно) для команды /profile. */
export function formatProfile(entries: string[]): string {
  if (entries.length === 0) {
    return 'Профиль пуст — пока ничего не знаю о ваших предпочтениях.\n\n';
  }
  const lines = entries.map((entry, index) => `  ${index + 1}. ${entry}`);
  return `Профиль пользователя:\n${lines.join('\n')}\n\n`;
}

/** Текст справки по интерактивным командам. */
export function helpText(): string {
  return (
    'Команды:\n' +
    '  /help               — этот список\n' +
    '  /sessions           — ветки (сохранённые сессии)\n' +
    '  /branch <имя>       — ответвиться в новую ветку с именем\n' +
    '  /switch <имя|id>    — переключиться на ветку\n' +
    '  /reset              — начать новую пустую ветку\n' +
    '  /task [текст]       — показать или задать текущую задачу\n' +
    '  /tasks              — список задач\n' +
    '  /task switch <id|имя> — переключиться на задачу\n' +
    '  /task done          — закрыть текущую задачу\n' +
    '  /task delete <id|имя> — удалить задачу\n' +
    '  /profile            — что известно о вас (профиль)\n' +
    '  /forget <n>         — забыть пункт профиля\n' +
    '  /system <текст>     — изменить системный промпт\n' +
    '  /file <путь>        — добавить содержимое файла в контекст\n' +
    '  /temp <число>       — изменить температуру\n' +
    '  /exit, /quit        — выход\n\n'
  );
}

/** Форматирует список веток (сессий) для команды /sessions. */
export function formatSessionList(summaries: SessionSummary[]): string {
  if (summaries.length === 0) {
    return 'Сохранённых веток нет.\n\n';
  }
  const lines = summaries.map(
    summary => `  ${summary.label ?? '—'}  (${summary.id})  ${summary.preview || '(пусто)'}`,
  );
  return `Ветки:\n${lines.join('\n')}\n\n`;
}

/** Утвердительный ли ответ пользователя (да/yes/…). */
function isAffirmative(reply: string): boolean {
  return ['да', 'yes', 'y', 'ага', 'давай', 'ок', 'ok', 'д'].includes(reply);
}

/** Отрицательный ли ответ пользователя (нет/no/…). */
function isNegative(reply: string): boolean {
  return ['нет', 'no', 'n', 'не', 'н'].includes(reply);
}

/** Перезаписывает системное сообщение сессии (действует с этого момента). */
function setSystemPrompt(session: Session, text: string): void {
  session.messages[0] = { role: 'system', content: text };
  session.updatedAt = new Date().toISOString();
}

/** Интерактивный режим: диалог с сохранением истории. */
export async function runInteractive(
  client: ChatCompletionClient,
  config: AppConfig,
  limits: GenerationLimits,
  disableThinking: boolean,
  temperature: number,
  stream: boolean,
  // Стратегия управления памятью диалога (окно/сжатие) и сколько свежего держать.
  memory: MemoryKind,
  keepRecent: number,
  // Транскрипт сессии (с системным сообщением); store=null — без персистентности.
  session: Session,
  store: SessionStore | null,
  input: Readable,
  output: Writable,
  // Передаётся явно — это же даёт тестам шов для подмены интерфейса.
  createInterface: typeof readline.createInterface,
  // Слоистая память (профиль + задача); по умолчанию выключена.
  memorySettings: MemorySettings = { enabled: false, profileStore: null, taskStore: null },
): Promise<void> {
  const readlineInterface = createInterface({ input, output });
  // Активная сессия (команды /branch, /switch, /reset могут её сменить).
  // Полный транскрипт храним в currentSession.messages; в модель уходит окно.
  let currentSession = session;
  // Бюджет истории зависит от контекста выбранной модели и резерва под ответ.
  const historyBudget = historyBudgetTokens(config.contextTokens, limits.maxTokens);
  // При слоистой памяти часть бюджета уходит профилю и задаче, остаток — короткой.
  const budgets = memorySettings.enabled
    ? layerBudgets(
        historyBudget,
        config.contextTokens,
        memorySettings.profileTokens,
        memorySettings.taskTokens,
      )
    : { profile: 0, task: 0, short: historyBudget };
  // Короткая память (окно/сжатие/факты): клиент сжатия — тот же (шов для дешёвой модели).
  const strategy = createMemoryStrategy(
    memory,
    budgets.short,
    keepRecent,
    client,
    config.requestTimeoutMs,
  );
  // Менеджер слоистой памяти поверх короткой стратегии.
  const memoryManager = new MemoryManager({
    enabled: memorySettings.enabled,
    strategy,
    budgets,
    client,
    requestTimeoutMs: config.requestTimeoutMs,
    profile: memorySettings.profileStore?.load() ?? emptyProfile(),
    profileStore: memorySettings.profileStore,
    taskStore: memorySettings.taskStore,
  });
  memoryManager.adopt(currentSession.taskId);
  if (memorySettings.initialTaskTitle !== undefined && memoryManager.currentTask() === null) {
    currentSession.taskId = memoryManager.setTask(memorySettings.initialTaskTitle).id;
    store?.save(currentSession);
  }
  // Метка строки доп. вызова короткой памяти: facts обновляет факты, прочие — сжимают.
  const memoryLabel = memory === 'facts' ? 'факты' : 'сжатие';
  // Суммарные токены за всю сессию — для итоговой сводки при выходе.
  const totals: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let requestCount = 0;
  // Печатает строку доп. вызова (сжатие/факты короткой памяти) и копит в итоги.
  const reportExtra = (usage: Usage | undefined, label: string): void => {
    output.write(
      `${formatUsageStats(usage, historyTokens(currentSession.messages), config, label)}\n\n`,
    );
    if (usage !== undefined) {
      totals.prompt_tokens += usage.prompt_tokens;
      totals.completion_tokens += usage.completion_tokens;
      totals.total_tokens += usage.total_tokens;
      requestCount++;
    }
  };
  // Явно показывает, ЧТО и в какой слой записано (с отступом от предыдущей строки),
  // затем строку стоимости вызова; копит токены в итоги.
  const printMemoryWrite = (report: MemoryWriteReport): void => {
    output.write('\n'); // отступ от реплики/ответа
    if (report.consolidated !== null) {
      output.write(`[профиль] консолидировано из ваших реплик: ${report.consolidated} пункт(ов)\n`);
      reportExtra(report.usage, 'профиль');
      return;
    }
    const parts: string[] = [];
    if (report.taskTitle !== null) {
      parts.push(`задача «${report.taskTitle}» ← ${report.taskFactCount} факт(ов)`);
    }
    if (report.profileAdded.length > 0) {
      parts.push(`профиль ← ${report.profileAdded.map(entry => `«${entry}»`).join(', ')}`);
    }
    output.write(`[память] ${parts.length > 0 ? parts.join('; ') : 'без изменений'}\n`);
    reportExtra(report.usage, 'память');
  };

  // Ctrl+C (SIGINT) и закрытие ввода (Ctrl+D / EOF) прерывают ожидание строки:
  // abort заставляет question отклониться, и цикл штатно завершается.
  const abortController = new AbortController();
  const requestStop = () => abortController.abort();
  readlineInterface.on('SIGINT', requestStop);
  readlineInterface.on('close', requestStop);

  output.write(
    `Чат с моделью «${config.model}» (температура ${temperature}). ` +
      'Сообщение — текст; команды — /help; выход — /exit или Ctrl+C.\n',
  );

  try {
    while (true) {
      let userInput: string;
      try {
        userInput = (
          await readlineInterface.question('Вы: ', { signal: abortController.signal })
        ).trim();
      } catch {
        // question отклонён из-за Ctrl+C / закрытия ввода — выходим без ошибки.
        break;
      }
      if (!userInput) continue;
      if (userInput === '/exit' || userInput === '/quit') break;
      if (userInput === '/help') {
        output.write(helpText());
        continue;
      }
      if (userInput === '/reset') {
        currentSession = newSession(config, limits);
        memoryManager.reset();
        memoryManager.adopt(currentSession.taskId); // новая ветка без задачи
        output.write('Начата новая сессия.\n\n');
        continue;
      }
      if (userInput === '/sessions') {
        output.write(store === null ? EPHEMERAL_NOTICE : formatSessionList(store.list()));
        continue;
      }
      if (userInput === '/branch' || userInput.startsWith('/branch ')) {
        const name = userInput.slice('/branch'.length).trim();
        if (store === null) {
          output.write(EPHEMERAL_NOTICE);
        } else if (!name) {
          output.write('Укажите имя ветки: /branch <имя>\n\n');
        } else if (name === currentSession.label || branchNameTaken(store, name)) {
          output.write(`Ветка «${name}» уже существует.\n\n`);
        } else {
          // Checkpoint: сохраняем текущую ветку и ответвляемся от неё в новую.
          const parentTaskId = currentSession.taskId;
          currentSession.updatedAt = new Date().toISOString();
          store.save(currentSession);
          currentSession = createSession(
            currentSession.model,
            [...currentSession.messages],
            undefined,
            undefined,
            name,
          );
          currentSession.taskId = parentTaskId; // ветка наследует задачу
          store.save(currentSession);
          memoryManager.reset();
          memoryManager.adopt(currentSession.taskId);
          output.write(`Создана ветка «${name}» от текущего места, переключились на неё.\n\n`);
        }
        continue;
      }
      if (userInput === '/switch' || userInput.startsWith('/switch ')) {
        const arg = userInput.slice('/switch'.length).trim();
        if (store === null) {
          output.write(EPHEMERAL_NOTICE);
        } else if (!arg) {
          output.write('Укажите имя или id ветки: /switch <имя|id>\n\n');
        } else if (arg === currentSession.label || arg === currentSession.id) {
          output.write(`Уже в ветке «${arg}».\n\n`);
        } else {
          const target = resolveBranch(store, arg);
          if (target === null) {
            output.write(`Ветка не найдена: ${arg}\n\n`);
          } else {
            currentSession.updatedAt = new Date().toISOString();
            store.save(currentSession);
            currentSession = target;
            memoryManager.reset();
            memoryManager.adopt(currentSession.taskId);
            output.write(`Переключились на ветку «${target.label ?? target.id}».\n\n`);
          }
        }
        continue;
      }
      if (userInput.startsWith('/system ')) {
        // userInput уже обрезан, поэтому после '/system ' гарантированно есть текст.
        setSystemPrompt(currentSession, userInput.slice('/system '.length).trim());
        store?.save(currentSession);
        output.write('Системный промпт обновлён.\n\n');
        continue;
      }
      if (userInput.startsWith('/file ')) {
        const path = userInput.slice('/file '.length).trim();
        let content: string;
        try {
          content = readFileContent(path);
        } catch (error) {
          output.write(`${describeError(error)}\n\n`);
          continue;
        }
        // Содержимое файла кладём в историю как контекст; модель не дёргаем —
        // ответит на следующий вопрос пользователя уже с файлом в контексте.
        const attachment = formatAttachment(path, content);
        currentSession.messages.push({ role: 'user', content: attachment });
        output.write(
          `Файл «${path}» добавлен в контекст (~${estimateTokens(attachment)} токенов).\n\n`,
        );
        continue;
      }
      if (userInput.startsWith('/temp ')) {
        const parsed = validTemperature(userInput.slice('/temp '.length).trim());
        if (parsed === null) {
          output.write('Некорректная температура — нужно неотрицательное число.\n\n');
        } else {
          temperature = parsed;
          output.write(`Температура установлена: ${temperature}\n\n`);
        }
        continue;
      }
      if (userInput === '/tasks') {
        output.write(
          memoryManager.enabled ? formatTaskList(memoryManager.listTasks()) : MEMORY_OFF_NOTICE,
        );
        continue;
      }
      if (userInput === '/task done') {
        if (!memoryManager.enabled) {
          output.write(MEMORY_OFF_NOTICE);
        } else {
          const closed = memoryManager.closeTask();
          if (closed === null) {
            output.write('Активной задачи нет.\n\n');
          } else {
            currentSession.taskId = undefined;
            store?.save(currentSession);
            output.write(`Задача «${closed}» закрыта.\n\n`);
          }
        }
        continue;
      }
      if (userInput.startsWith('/task switch ')) {
        const arg = userInput.slice('/task switch '.length).trim();
        if (!memoryManager.enabled) {
          output.write(MEMORY_OFF_NOTICE);
        } else {
          const task = memoryManager.switchTask(arg);
          if (task === null) {
            output.write(`Задача не найдена: ${arg}\n\n`);
          } else {
            currentSession.taskId = task.id;
            store?.save(currentSession);
            output.write(`Переключились на задачу «${task.title}».\n\n`);
          }
        }
        continue;
      }
      if (userInput.startsWith('/task delete ')) {
        const arg = userInput.slice('/task delete '.length).trim();
        if (!memoryManager.enabled) {
          output.write(MEMORY_OFF_NOTICE);
        } else {
          const removed = memoryManager.deleteTask(arg);
          if (removed === null) {
            output.write(`Задача не найдена: ${arg}\n\n`);
          } else {
            if (currentSession.taskId === removed.id) {
              currentSession.taskId = undefined; // удалили активную — отвязываем сессию
              store?.save(currentSession);
            }
            output.write(`Задача «${removed.title}» удалена.\n\n`);
          }
        }
        continue;
      }
      if (userInput.startsWith('/task ')) {
        if (!memoryManager.enabled) {
          output.write(MEMORY_OFF_NOTICE);
        } else {
          const task = memoryManager.setTask(userInput.slice('/task '.length).trim());
          currentSession.taskId = task.id;
          store?.save(currentSession);
          output.write(`Задача установлена: ${task.title}\n\n`);
        }
        continue;
      }
      if (userInput === '/task') {
        output.write(
          memoryManager.enabled
            ? formatCurrentTask(memoryManager.currentTask())
            : MEMORY_OFF_NOTICE,
        );
        continue;
      }
      if (userInput === '/profile') {
        output.write(
          memoryManager.enabled ? formatProfile(memoryManager.profileEntries()) : MEMORY_OFF_NOTICE,
        );
        continue;
      }
      if (userInput.startsWith('/forget ')) {
        if (!memoryManager.enabled) {
          output.write(MEMORY_OFF_NOTICE);
        } else {
          const index = Number(userInput.slice('/forget '.length).trim());
          const removed = Number.isInteger(index) ? memoryManager.forgetProfile(index) : null;
          output.write(
            removed === null ? 'Нет такого пункта профиля.\n\n' : `Забыто: ${removed}\n\n`,
          );
        }
        continue;
      }

      currentSession.messages.push({ role: 'user', content: userInput });
      // Сначала наблюдаем (извлечение памяти + детект новой задачи), затем — если
      // предложена новая задача — спрашиваем подтверждение ДО ответа модели, чтобы
      // подтверждённая задача уже попала в контекст этого ответа.
      const writeReport = await memoryManager.observe(currentSession.messages);
      if (writeReport !== null) {
        printMemoryWrite(writeReport);
      }
      const proposed = memoryManager.takeProposal();
      if (proposed !== null) {
        let reply: string;
        try {
          reply = (
            await readlineInterface.question(
              `Похоже на новую задачу. Сделать задачей сессии «${proposed}»? (да/нет) `,
              { signal: abortController.signal },
            )
          )
            .trim()
            .toLowerCase();
        } catch {
          break; // подтверждение прервано (Ctrl+C / EOF) — выходим
        }
        if (isAffirmative(reply)) {
          currentSession.taskId = memoryManager.setTask(proposed).id;
          store?.save(currentSession);
          output.write(`Задача установлена: ${proposed}\n\n`);
        } else {
          memoryManager.declineProposal(proposed);
          if (isNegative(reply)) {
            output.write('Хорошо, без задачи.\n\n');
          }
        }
      }
      // Сборка контекста (короткая память + профиль + задача) и ответ.
      const windowed = await memoryManager.build(currentSession.messages, usage =>
        reportExtra(usage, memoryLabel),
      );
      try {
        let answer: string;
        let usage: Usage | undefined;
        if (stream) {
          // Пустая строка-отступ, чтобы прелоадер/ответ не «прилипали» к строке «Вы: …».
          output.write('\n');
          const result = await streamAnswer(
            client,
            windowed,
            config.requestTimeoutMs,
            limits,
            disableThinking,
            temperature,
            output,
            () => output.write(`${ASSISTANT_LABEL}: `),
          );
          answer = result.content;
          usage = result.usage;
          output.write('\n\n');
        } else {
          const result = await askModel(
            client,
            windowed,
            config.requestTimeoutMs,
            limits,
            disableThinking,
            temperature,
          );
          answer = result.content;
          usage = result.usage;
          output.write(`\n${ASSISTANT_LABEL}: ${answer}\n\n`);
        }
        currentSession.messages.push({ role: 'assistant', content: answer });
        // Сохраняем сессию после завершённого обмена (store=null при --ephemeral).
        currentSession.updatedAt = new Date().toISOString();
        store?.save(currentSession);
        // Статистика по запросу и истории под ответом.
        output.write(
          `${formatUsageStats(usage, historyTokens(currentSession.messages), config)}\n\n`,
        );
        // Накапливаем итог за сессию (если провайдер прислал usage).
        if (usage !== undefined) {
          totals.prompt_tokens += usage.prompt_tokens;
          totals.completion_tokens += usage.completion_tokens;
          totals.total_tokens += usage.total_tokens;
          requestCount++;
        }
      } catch (error) {
        // Откатываем неудачный ход, чтобы история осталась согласованной.
        currentSession.messages.pop();
        output.write(`\n[ошибка] ${describeError(error)}\n\n`);
      }
    }
    // Консолидация профиля: устойчивые черты пользователя из всей сессии.
    const consolidationReport = await memoryManager.consolidate(currentSession.messages);
    if (consolidationReport !== null) {
      printMemoryWrite(consolidationReport);
    }
    // Итоговая сводка за сессию — только если были запросы с usage.
    if (requestCount > 0) {
      output.write(`\n${formatSessionTotals(totals, config)}\n`);
    }
    output.write('\nДо встречи!\n');
  } finally {
    readlineInterface.close();
  }
}

/** Возвращает человекочитаемое описание ошибки. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') {
      return 'превышено время ожидания ответа от API.';
    }
    return error.message;
  }
  return String(error);
}

/** Результат разбора аргументов: промпт, ограничения, флаги и температура. */
export interface ParsedArgs {
  prompt: string;
  limits: GenerationLimits;
  disableThinking: boolean;
  /** Температура из флага `--temperature`; undefined — взять из конфигурации. */
  temperature?: number;
  /** Размер контекста из флага `--context-tokens`; undefined — взять из конфигурации. */
  contextTokens?: number;
  /** Потоковый вывод ответа; выключается флагом `--no-stream`. */
  stream: boolean;
  /** Не сохранять сессию (флаг `--ephemeral`). */
  ephemeral: boolean;
  /** Переключиться на ветку при старте: `last`, имя или id (`--switch`). */
  switchTo?: string;
  /** Ответвиться в новую ветку с этим именем при старте (`--branch`). */
  branchName?: string;
  /** Файлы (`--file`, можно несколько), чьё содержимое идёт в запрос. */
  files: string[];
  /** Стратегия управления памятью диалога (`--memory`); по умолчанию `window`. */
  memory: MemoryKind;
  /** Сколько последних реплик держать дословно при summary (`--keep-recent`). */
  keepRecent: number;
  /** Выключить слоистую память — профиль и задачу (`--no-memory`). */
  noMemory: boolean;
  /** Стартовая задача (`--task <текст>`). */
  task?: string;
  /** Размер блока профиля в токенах (`--profile-tokens`); иначе эвристика. */
  profileTokens?: number;
  /** Размер блока задачи в токенах (`--task-tokens`); иначе эвристика. */
  taskTokens?: number;
}

/** Разбирает значение флага как положительное целое или бросает понятную ошибку. */
function parsePositiveInteger(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} требует положительное целое, получено: ${value}`);
  }
  return parsed;
}

/**
 * Читает JSON-схему из файла и оборачивает её в строгий response_format.
 * Файл должен содержать саму JSON Schema (объект); strict включается всегда.
 */
function loadJsonSchema(path: string): ResponseFormat {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`Не удалось прочитать файл схемы: ${path}`);
  }

  let schema: Record<string, unknown>;
  try {
    schema = JSON.parse(raw);
  } catch {
    throw new Error(`Невалидный JSON в файле схемы: ${path}`);
  }

  return { type: 'json_schema', json_schema: { name: 'response', strict: true, schema } };
}

/** Читает текстовый файл или бросает понятную ошибку. */
function readFileContent(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    throw new Error(`Не удалось прочитать файл: ${path}`);
  }
}

/** Оформляет содержимое файла для вставки в запрос (с пометкой и кодовым блоком). */
export function formatAttachment(path: string, content: string): string {
  return `Содержимое файла «${path}»:\n\`\`\`\n${content}\n\`\`\``;
}

/** Читает файлы и собирает их оформленное содержимое в один блок. */
export function attachFiles(paths: string[]): string {
  return paths.map(path => formatAttachment(path, readFileContent(path))).join('\n\n');
}

/** Объединяет вложения файлов и текст промпта в одно сообщение. */
export function combinePrompt(attachments: string, prompt: string): string {
  return attachments && prompt ? `${attachments}\n\n${prompt}` : attachments || prompt;
}

/**
 * Разбирает аргументы (без `node` и имени скрипта): флаги `--max-tokens`,
 * `--stop` (можно повторять), `--json`, `--json-schema`, `--no-thinking`,
 * `--temperature` и `--context-tokens` задают параметры запроса, остальное —
 * слова промпта. Значение флага можно писать как `--flag=value` или `--flag value`.
 */
export function parseArgs(args: string[]): ParsedArgs {
  const promptParts: string[] = [];
  const stops: string[] = [];
  const files: string[] = [];
  const limits: GenerationLimits = {};
  let disableThinking = false;
  let temperature: number | undefined;
  let contextTokens: number | undefined;
  let stream = true;
  let ephemeral = false;
  let switchTo: string | undefined;
  let branchName: string | undefined;
  let memory: MemoryKind = 'window';
  let keepRecent = DEFAULT_KEEP_RECENT;
  let noMemory = false;
  let task: string | undefined;
  let profileTokens: number | undefined;
  let taskTokens: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      promptParts.push(arg);
      continue;
    }

    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);

    if (name === '--json') {
      limits.responseFormat = { type: 'json_object' };
      continue;
    }
    if (name === '--no-thinking') {
      disableThinking = true;
      continue;
    }
    if (name === '--no-stream') {
      stream = false;
      continue;
    }
    if (name === '--ephemeral') {
      ephemeral = true;
      continue;
    }
    if (name === '--no-memory') {
      noMemory = true;
      continue;
    }
    if (name === '--switch') {
      // Без значения — последняя ветка; иначе имя/id (через `=`).
      switchTo = eq === -1 ? 'last' : arg.slice(eq + 1);
      continue;
    }

    const value = eq === -1 ? args[++i] : arg.slice(eq + 1);
    if (value === undefined) {
      throw new Error(`Не указано значение для ${name}`);
    }

    if (name === '--max-tokens') {
      limits.maxTokens = parsePositiveInteger(name, value);
    } else if (name === '--context-tokens') {
      contextTokens = parsePositiveInteger(name, value);
    } else if (name === '--stop') {
      stops.push(value);
    } else if (name === '--file') {
      files.push(value);
    } else if (name === '--memory') {
      if (value !== 'window' && value !== 'summary' && value !== 'facts') {
        throw new Error(`--memory требует window, summary или facts, получено: ${value}`);
      }
      memory = value;
    } else if (name === '--keep-recent') {
      keepRecent = parsePositiveInteger(name, value);
    } else if (name === '--branch') {
      branchName = value;
    } else if (name === '--task') {
      task = value;
    } else if (name === '--profile-tokens') {
      profileTokens = parsePositiveInteger(name, value);
    } else if (name === '--task-tokens') {
      taskTokens = parsePositiveInteger(name, value);
    } else if (name === '--json-schema') {
      limits.responseFormat = loadJsonSchema(value);
    } else if (name === '--temperature') {
      const parsed = validTemperature(value);
      if (parsed === null) {
        throw new Error(`--temperature требует неотрицательное число, получено: ${value}`);
      }
      temperature = parsed;
    } else {
      throw new Error(`Неизвестный флаг: ${name}`);
    }
  }

  if (stops.length > 0) {
    limits.stop = stops.length === 1 ? stops[0] : stops;
  }

  return {
    prompt: promptParts.join(' ').trim(),
    limits,
    disableThinking,
    temperature,
    contextTokens,
    stream,
    ephemeral,
    switchTo,
    branchName,
    files,
    memory,
    keepRecent,
    noMemory,
    task,
    profileTokens,
    taskTokens,
  };
}

/** Точка входа: выбирает режим работы по аргументам командной строки. */
export async function main(argv: string[], input: Readable, output: Writable): Promise<void> {
  const config = loadConfig();
  const client = new ChatCompletionClient(config);

  const {
    prompt,
    limits,
    disableThinking,
    temperature: parsedTemperature,
    contextTokens: parsedContextTokens,
    stream,
    ephemeral,
    switchTo,
    branchName,
    files,
    memory,
    keepRecent,
    noMemory,
    task,
    profileTokens,
    taskTokens,
  } = parseArgs(argv.slice(2));
  // Флаг приоритетнее переменной среды; не задан — берём из конфигурации.
  const temperature = parsedTemperature ?? config.temperature;
  const contextTokens = parsedContextTokens ?? config.contextTokens;
  const interactiveConfig = { ...config, contextTokens };

  // Содержимое --file идёт в запрос вместе с текстом промпта (режим одного запроса).
  const fullPrompt = combinePrompt(files.length > 0 ? attachFiles(files) : '', prompt);

  if (fullPrompt) {
    await runOnce(client, config, fullPrompt, limits, disableThinking, temperature, stream, output);
  } else {
    // --ephemeral — без хранилищ на диске; иначе файловые хранилища.
    const store = ephemeral ? null : new FileSessionStore(sessionDirectory());
    const session = resolveSession(store, interactiveConfig, limits, switchTo, branchName);
    // Слоистая память включена по умолчанию; --ephemeral держит её в памяти.
    const memorySettings: MemorySettings = {
      enabled: !noMemory,
      profileStore: ephemeral ? null : new FileProfileStore(profilePath()),
      taskStore: ephemeral ? null : new FileTaskStore(tasksDirectory()),
      profileTokens,
      taskTokens,
      initialTaskTitle: task,
    };
    await runInteractive(
      client,
      interactiveConfig,
      limits,
      disableThinking,
      temperature,
      stream,
      memory,
      keepRecent,
      session,
      store,
      input,
      output,
      readline.createInterface,
      memorySettings,
    );
  }
}

/** Сообщает о неперехваченной ошибке и помечает запуск как неуспешный. */
export function reportFatalError(error: unknown): void {
  console.error(`Ошибка: ${describeError(error)}`);
  process.exitCode = 1;
}
