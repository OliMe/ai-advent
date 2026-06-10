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

/** Запускает один запрос с таймаутом и ограничениями и возвращает ответ модели. */
export async function askModel(
  client: ChatCompletionClient,
  messages: ChatMessage[],
  requestTimeoutMs: number,
  limits: GenerationLimits,
  disableThinking: boolean,
  temperature: number,
): Promise<string> {
  // AbortSignal.timeout даёт при срабатывании TimeoutError — его легко
  // отличить от AbortError, который возникает при отмене пользователем.
  const signal = AbortSignal.timeout(requestTimeoutMs);
  return client.complete(messages, { signal, disableThinking, temperature, ...limits });
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
export function resolveSession(
  store: SessionStore | null,
  config: AppConfig,
  limits: GenerationLimits,
  resume: string | undefined,
  fork: boolean,
): Session {
  const freshSession = (): Session =>
    createSession(config.model, [
      { role: 'system', content: augmentSystemPrompt(config.systemPrompt, limits) },
    ]);

  // Без хранилища (--ephemeral) или без запроса на восстановление — новая сессия.
  if (store === null || resume === undefined) {
    return freshSession();
  }

  const existing = resume === 'last' ? store.latest() : store.load(resume);
  if (existing === null) {
    if (resume === 'last') {
      return freshSession(); // прошлых сессий ещё нет
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
    const answer = await askModel(
      client,
      messages,
      config.requestTimeoutMs,
      limits,
      disableThinking,
      temperature,
    );
    output.write(answer + '\n');
  }
}

/** Интерактивный режим: диалог с сохранением истории. */
export async function runInteractive(
  client: ChatCompletionClient,
  config: AppConfig,
  limits: GenerationLimits,
  disableThinking: boolean,
  temperature: number,
  stream: boolean,
  // Транскрипт сессии (с системным сообщением); store=null — без персистентности.
  session: Session,
  store: SessionStore | null,
  input: Readable,
  output: Writable,
  // Передаётся явно — это же даёт тестам шов для подмены интерфейса.
  createInterface: typeof readline.createInterface,
): Promise<void> {
  const readlineInterface = createInterface({ input, output });
  // Полный транскрипт храним в session.messages; в модель уходит окно.
  const history = session.messages;
  // Бюджет истории зависит от контекста выбранной модели и резерва под ответ.
  const historyBudget = historyBudgetTokens(config.contextTokens, limits.maxTokens);

  // Ctrl+C (SIGINT) и закрытие ввода (Ctrl+D / EOF) прерывают ожидание строки:
  // abort заставляет question отклониться, и цикл штатно завершается.
  const abortController = new AbortController();
  const requestStop = () => abortController.abort();
  readlineInterface.on('SIGINT', requestStop);
  readlineInterface.on('close', requestStop);

  output.write(
    `Чат с моделью «${config.model}» (температура ${temperature}). ` +
      'Сообщение — текст; смена температуры — /temp <число>; выход — /exit или Ctrl+C.\n',
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

      history.push({ role: 'user', content: userInput });
      // Скользящее окно: в модель уходит обрезанный вид транскрипта (сам
      // транскрипт остаётся полным — для сохранения сессии).
      const windowed = trimHistoryToBudget(history, historyBudget);
      try {
        let answer: string;
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
          output.write('\n\n');
        } else {
          answer = await askModel(
            client,
            windowed,
            config.requestTimeoutMs,
            limits,
            disableThinking,
            temperature,
          );
          output.write(`\n${ASSISTANT_LABEL}: ${answer}\n\n`);
        }
        history.push({ role: 'assistant', content: answer });
        // Сохраняем сессию после завершённого обмена (store=null при --ephemeral).
        session.updatedAt = new Date().toISOString();
        store?.save(session);
      } catch (error) {
        // Откатываем неудачный ход, чтобы история осталась согласованной.
        history.pop();
        output.write(`\n[ошибка] ${describeError(error)}\n\n`);
      }
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

/**
 * Разбирает аргументы (без `node` и имени скрипта): флаги `--max-tokens`,
 * `--stop` (можно повторять), `--json`, `--json-schema`, `--no-thinking`,
 * `--temperature` и `--context-tokens` задают параметры запроса, остальное —
 * слова промпта. Значение флага можно писать как `--flag=value` или `--flag value`.
 */
export function parseArgs(args: string[]): ParsedArgs {
  const promptParts: string[] = [];
  const stops: string[] = [];
  const limits: GenerationLimits = {};
  let disableThinking = false;
  let temperature: number | undefined;
  let contextTokens: number | undefined;
  let stream = true;
  let ephemeral = false;
  let resume: string | undefined;
  let fork = false;

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
  } = parseArgs(argv.slice(2));
  // Флаг приоритетнее переменной среды; не задан — берём из конфигурации.
  const temperature = parsedTemperature ?? config.temperature;
  const contextTokens = parsedContextTokens ?? config.contextTokens;
  const interactiveConfig = { ...config, contextTokens };

  if (prompt) {
    await runOnce(client, config, prompt, limits, disableThinking, temperature, stream, output);
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
