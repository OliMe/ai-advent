import * as readline from 'node:readline/promises';
import { readFileSync } from 'node:fs';
import type { Readable, Writable } from 'node:stream';
import { loadConfig, ChatCompletionClient } from '../../core/src/index.ts';
import type {
  AppConfig,
  ChatMessage,
  GenerationLimits,
  ResponseFormat,
} from '../../core/src/index.ts';

/** Метка ответа модели в интерактивном режиме. */
const ASSISTANT_LABEL = 'Ассистент';

const MIN_TEMPERATURE = 0;
const MAX_TEMPERATURE = 2;

/** Проверяет температуру (число от 0 до 2); возвращает число или null при ошибке. */
export function validTemperature(value: string): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= MIN_TEMPERATURE && parsed <= MAX_TEMPERATURE
    ? parsed
    : null;
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

/** Режим одного запроса: промпт передан аргументами командной строки. */
export async function runOnce(
  client: ChatCompletionClient,
  config: AppConfig,
  prompt: string,
  limits: GenerationLimits,
  disableThinking: boolean,
  temperature: number,
  output: Writable,
): Promise<void> {
  const messages: ChatMessage[] = [
    { role: 'system', content: augmentSystemPrompt(config.systemPrompt, limits) },
    { role: 'user', content: prompt },
  ];
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

/** Интерактивный режим: диалог с сохранением истории. */
export async function runInteractive(
  client: ChatCompletionClient,
  config: AppConfig,
  limits: GenerationLimits,
  disableThinking: boolean,
  temperature: number,
  input: Readable,
  output: Writable,
  // Передаётся явно — это же даёт тестам шов для подмены интерфейса.
  createInterface: typeof readline.createInterface,
): Promise<void> {
  const readlineInterface = createInterface({ input, output });
  const history: ChatMessage[] = [
    { role: 'system', content: augmentSystemPrompt(config.systemPrompt, limits) },
  ];

  // Ctrl+C (SIGINT) и закрытие ввода (Ctrl+D / EOF) прерывают ожидание строки:
  // abort заставляет question отклониться, и цикл штатно завершается.
  const abortController = new AbortController();
  const requestStop = () => abortController.abort();
  readlineInterface.on('SIGINT', requestStop);
  readlineInterface.on('close', requestStop);

  output.write(
    `Чат с моделью «${config.model}» (температура ${temperature}). ` +
      'Сообщение — текст; смена температуры — /temp <0–2>; выход — /exit или Ctrl+C.\n',
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
          output.write('Некорректная температура — нужно число от 0 до 2.\n\n');
        } else {
          temperature = parsed;
          output.write(`Температура установлена: ${temperature}\n\n`);
        }
        continue;
      }

      history.push({ role: 'user', content: userInput });
      try {
        const answer = await askModel(
          client,
          history,
          config.requestTimeoutMs,
          limits,
          disableThinking,
          temperature,
        );
        history.push({ role: 'assistant', content: answer });
        output.write(`\n${ASSISTANT_LABEL}: ${answer}\n\n`);
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
 * `--stop` (можно повторять), `--json`, `--json-schema` и `--no-thinking`
 * задают параметры запроса, остальное — слова промпта. Значение флага можно
 * писать как `--flag=value` или `--flag value`.
 */
export function parseArgs(args: string[]): ParsedArgs {
  const promptParts: string[] = [];
  const stops: string[] = [];
  const limits: GenerationLimits = {};
  let disableThinking = false;
  let temperature: number | undefined;

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

    const value = eq === -1 ? args[++i] : arg.slice(eq + 1);
    if (value === undefined) {
      throw new Error(`Не указано значение для ${name}`);
    }

    if (name === '--max-tokens') {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`--max-tokens требует положительное целое, получено: ${value}`);
      }
      limits.maxTokens = parsed;
    } else if (name === '--stop') {
      stops.push(value);
    } else if (name === '--json-schema') {
      limits.responseFormat = loadJsonSchema(value);
    } else if (name === '--temperature') {
      const parsed = validTemperature(value);
      if (parsed === null) {
        throw new Error(`--temperature требует число от 0 до 2, получено: ${value}`);
      }
      temperature = parsed;
    } else {
      throw new Error(`Неизвестный флаг: ${name}`);
    }
  }

  if (stops.length > 0) {
    limits.stop = stops.length === 1 ? stops[0] : stops;
  }

  return { prompt: promptParts.join(' ').trim(), limits, disableThinking, temperature };
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
  } = parseArgs(argv.slice(2));
  // Если флаг не задан — берём температуру из конфигурации.
  const temperature = parsedTemperature ?? config.temperature;

  if (prompt) {
    await runOnce(client, config, prompt, limits, disableThinking, temperature, output);
  } else {
    await runInteractive(
      client,
      config,
      limits,
      disableThinking,
      temperature,
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
