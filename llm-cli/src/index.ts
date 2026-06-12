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
/** Новая сессия с системным сообщением из текущего конфига. */
export function newSession(config: AppConfig, limits: GenerationLimits): Session {
  return createSession(config.model, [
    { role: 'system', content: augmentSystemPrompt(config.systemPrompt, limits) },
  ]);
}

export function resolveSession(
  store: SessionStore | null,
  config: AppConfig,
  limits: GenerationLimits,
  resume: string | undefined,
  fork: boolean,
): Session {
  // Без хранилища (--ephemeral) или без запроса на восстановление — новая сессия.
  if (store === null || resume === undefined) {
    return newSession(config, limits);
  }

  const existing = resume === 'last' ? store.latest() : store.load(resume);
  if (existing === null) {
    if (resume === 'last') {
      return newSession(config, limits); // прошлых сессий ещё нет
    }
    throw new Error(`Сессия не найдена: ${resume}`);
  }
  if (fork) {
    return createSession(existing.model, [...existing.messages]);
  }
  return existing;
}

/** Сколько символов считаем за один токен в грубой оценке (провайдер-агностично). */
const CHARS_PER_TOKEN = 3;
/** Накладные токены на одно сообщение (роль и служебная разметка). */
const MESSAGE_OVERHEAD_TOKENS = 4;
/** Сколько токенов резервируем под ответ, если --max-tokens не задан. */
const DEFAULT_RESPONSE_RESERVE_TOKENS = 1024;
/** Нижняя граница бюджета истории, чтобы он не оказался нулём/отрицательным. */
const MIN_HISTORY_BUDGET_TOKENS = 256;

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

/** Стратегия управления памятью диалога: окно или сжатие. */
export type MemoryKind = 'window' | 'summary';

/** Готовит сообщения для запроса к модели из полного транскрипта сессии. */
export interface MemoryStrategy {
  prepare(
    messages: ChatMessage[],
    onCompression?: (usage: Usage | undefined) => void,
  ): Promise<ChatMessage[]>;
  /** Сбрасывает состояние при смене сессии (/reset, /resume, /fork). */
  reset(): void;
}

/** Оставляет самые свежие реплики в пределах бюджета; возвращает их и число «спила». */
function fitFromNewest(
  messages: ChatMessage[],
  budget: number,
): { kept: ChatMessage[]; spillCount: number } {
  const keptInReverse: ChatMessage[] = [];
  let used = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const cost = messageTokens(messages[index]);
    if (keptInReverse.length > 0 && used + cost > budget) {
      break;
    }
    keptInReverse.push(messages[index]);
    used += cost;
  }
  keptInReverse.reverse();
  return { kept: keptInReverse, spillCount: messages.length - keptInReverse.length };
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

/** Потолок длины резюме: доля бюджета, но не ниже минимума. */
function summaryMaxTokens(budget: number): number {
  return Math.max(64, Math.floor(budget / 4));
}

/**
 * Стратегия сжатия: старые реплики, не помещающиеся в бюджет, сворачиваются в
 * системное резюме (отдельным вызовом модели), свежие остаются дословно. При
 * сбое сжатия на этот ход откатывается к окну.
 */
class SummaryStrategy implements MemoryStrategy {
  private readonly budget: number;
  private readonly client: ChatCompletionClient;
  private readonly requestTimeoutMs: number;
  private summary = '';
  private summarizedCount = 0;

  constructor(budget: number, client: ChatCompletionClient, requestTimeoutMs: number) {
    this.budget = budget;
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
      maxTokens: summaryMaxTokens(this.budget),
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
    const systemTokens = messageTokens(systemMessage);
    try {
      // Сворачиваем «спил», пока несвёрнутые свежие реплики не уложатся в бюджет.
      while (true) {
        const summaryMsg = this.summaryMessage();
        const summaryTok = summaryMsg ? messageTokens(summaryMsg) : 0;
        const available = this.budget - systemTokens - summaryTok;
        const pending = conversation.slice(this.summarizedCount);
        const { kept, spillCount } = fitFromNewest(pending, available);
        if (spillCount === 0) {
          return [systemMessage, ...(summaryMsg ? [summaryMsg] : []), ...kept];
        }
        const result = await this.fold(pending.slice(0, spillCount));
        this.summarizedCount += spillCount;
        onCompression?.(result.usage);
      }
    } catch {
      // Сжатие не удалось — мягко откатываемся к окну на этот ход.
      return trimHistoryToBudget(messages, this.budget);
    }
  }
}

/**
 * Создаёт стратегию памяти. Клиент сжатия инъектируется отдельно — это шов,
 * чтобы в будущем назначить более дешёвую/специализированную модель.
 */
export function createMemoryStrategy(
  kind: MemoryKind,
  budget: number,
  summaryClient: ChatCompletionClient,
  requestTimeoutMs: number,
): MemoryStrategy {
  return kind === 'summary'
    ? new SummaryStrategy(budget, summaryClient, requestTimeoutMs)
    : new WindowStrategy(budget);
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
    '  /help            — этот список\n' +
    '  /sessions        — сохранённые сессии\n' +
    '  /resume <id>     — восстановить сессию\n' +
    '  /fork <id>       — ответвиться от сессии в новую\n' +
    '  /reset           — начать новую пустую сессию\n' +
    '  /system <текст>  — изменить системный промпт\n' +
    '  /file <путь>     — добавить содержимое файла в контекст\n' +
    '  /temp <число>    — изменить температуру\n' +
    '  /exit, /quit     — выход\n\n'
  );
}

/** Форматирует список сессий для команды /sessions. */
export function formatSessionList(summaries: SessionSummary[]): string {
  if (summaries.length === 0) {
    return 'Сохранённых сессий нет.\n\n';
  }
  const lines = summaries.map(summary => `  ${summary.id}  ${summary.preview || '(пусто)'}`);
  return `Сессии:\n${lines.join('\n')}\n\n`;
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
  // Стратегия управления памятью диалога (окно/сжатие).
  memory: MemoryKind,
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
  const strategy = createMemoryStrategy(memory, historyBudget, client, config.requestTimeoutMs);
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
      if (userInput.startsWith('/resume ') || userInput.startsWith('/fork ')) {
        const isFork = userInput.startsWith('/fork ');
        const id = userInput.slice((isFork ? '/fork ' : '/resume ').length).trim();
        const loaded = store?.load(id) ?? null;
        if (store === null) {
          output.write(EPHEMERAL_NOTICE);
        } else if (loaded === null) {
          output.write(`Сессия не найдена: ${id}\n\n`);
        } else {
          currentSession = isFork ? createSession(loaded.model, [...loaded.messages]) : loaded;
          strategy.reset();
          output.write(`${isFork ? 'Ответвление от' : 'Восстановлена'} сессия ${id}.\n\n`);
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
      // полным). Прогон сжатия печатается отдельной строкой и идёт в итоги.
      const onCompression = (compressionUsage: Usage | undefined): void => {
        output.write(
          `${formatUsageStats(compressionUsage, historyTokens(currentSession.messages), config, 'сжатие')}\n\n`,
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
  /** Восстановить сессию: `last` или id; undefined — новая сессия. */
  resume?: string;
  /** Ветвить восстановленную сессию в новую (флаг `--fork`). */
  fork: boolean;
  /** Файлы (`--file`, можно несколько), чьё содержимое идёт в запрос. */
  files: string[];
  /** Стратегия управления памятью диалога (`--memory`); по умолчанию `window`. */
  memory: MemoryKind;
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
  let resume: string | undefined;
  let fork = false;
  let memory: MemoryKind = 'window';

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
    if (name === '--fork') {
      fork = true;
      continue;
    }
    if (name === '--resume') {
      // Без значения — последняя сессия; иначе конкретный id (через `=`).
      resume = eq === -1 ? 'last' : arg.slice(eq + 1);
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
      if (value !== 'window' && value !== 'summary') {
        throw new Error(`--memory требует window или summary, получено: ${value}`);
      }
      memory = value;
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
    resume,
    fork,
    files,
    memory,
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
    resume,
    fork,
    files,
    memory,
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
    const session = resolveSession(store, interactiveConfig, limits, resume, fork);
    await runInteractive(
      client,
      interactiveConfig,
      limits,
      disableThinking,
      temperature,
      stream,
      memory,
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
