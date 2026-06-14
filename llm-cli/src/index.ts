import * as readline from 'node:readline/promises';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import {
  loadConfig,
  ChatCompletionClient,
  FileSessionStore,
  createSession,
} from '../../core/src/index.ts';
import type {
  AppConfig,
  ChatMessage,
  CompletionResult,
  GenerationLimits,
  ResponseFormat,
  Session,
  SessionStore,
  SessionSummary,
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

/** Текст справки по интерактивным командам. */
export function helpText(): string {
  return (
    'Команды:\n' +
    '  /help             — этот список\n' +
    '  /sessions         — ветки (сохранённые сессии)\n' +
    '  /branch <имя>     — ответвиться в новую ветку с именем\n' +
    '  /switch <имя|id>  — переключиться на ветку\n' +
    '  /reset            — начать новую пустую ветку\n' +
    '  /system <текст>   — изменить системный промпт\n' +
    '  /file <путь>      — добавить содержимое файла в контекст\n' +
    '  /temp <число>     — изменить температуру\n' +
    '  /exit, /quit      — выход\n\n'
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
): Promise<void> {
  const readlineInterface = createInterface({ input, output });
  // Активная сессия (команды /resume, /fork, /reset могут её сменить).
  // Полный транскрипт храним в currentSession.messages; в модель уходит окно.
  let currentSession = session;
  // Бюджет истории зависит от контекста выбранной модели и резерва под ответ.
  const historyBudget = historyBudgetTokens(config.contextTokens, limits.maxTokens);
  // Стратегия памяти: клиент сжатия — тот же (шов для будущей дешёвой модели).
  const strategy = createMemoryStrategy(
    memory,
    historyBudget,
    keepRecent,
    client,
    config.requestTimeoutMs,
  );
  // Метка строки доп. вызова стратегии: facts обновляет факты, прочие — сжимают.
  const memoryLabel = memory === 'facts' ? 'факты' : 'сжатие';
  // Суммарные токены за всю сессию — для итоговой сводки при выходе.
  const totals: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let requestCount = 0;

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
        strategy.reset();
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
          currentSession.updatedAt = new Date().toISOString();
          store.save(currentSession);
          currentSession = createSession(
            currentSession.model,
            [...currentSession.messages],
            undefined,
            undefined,
            name,
          );
          store.save(currentSession);
          strategy.reset();
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
            strategy.reset();
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

      currentSession.messages.push({ role: 'user', content: userInput });
      // Стратегия памяти готовит, что уйдёт в модель (сам транскрипт остаётся
      // полным). Доп. вызов (сжатие/факты) печатается строкой и идёт в итоги.
      const onCompression = (compressionUsage: Usage | undefined): void => {
        output.write(
          `${formatUsageStats(compressionUsage, historyTokens(currentSession.messages), config, memoryLabel)}\n\n`,
        );
        if (compressionUsage !== undefined) {
          totals.prompt_tokens += compressionUsage.prompt_tokens;
          totals.completion_tokens += compressionUsage.completion_tokens;
          totals.total_tokens += compressionUsage.total_tokens;
          requestCount++;
        }
      };
      const windowed = await strategy.prepare(currentSession.messages, onCompression);
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
    // --ephemeral — без хранилища; иначе файловое хранилище сессий.
    const store = ephemeral ? null : new FileSessionStore(sessionDirectory());
    const session = resolveSession(store, interactiveConfig, limits, switchTo, branchName);
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
    );
  }
}

/** Сообщает о неперехваченной ошибке и помечает запуск как неуспешный. */
export function reportFatalError(error: unknown): void {
  console.error(`Ошибка: ${describeError(error)}`);
  process.exitCode = 1;
}
