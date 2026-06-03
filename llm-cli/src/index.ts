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

/** Запускает один запрос с таймаутом и ограничениями и возвращает ответ модели. */
export async function askModel(
  client: ChatCompletionClient,
  messages: ChatMessage[],
  requestTimeoutMs: number,
  limits: GenerationLimits,
  disableThinking: boolean,
): Promise<string> {
  // AbortSignal.timeout даёт при срабатывании TimeoutError — его легко
  // отличить от AbortError, который возникает при отмене пользователем.
  const signal = AbortSignal.timeout(requestTimeoutMs);
  return client.complete(messages, { signal, disableThinking, ...limits });
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
  output: Writable,
): Promise<void> {
  const messages: ChatMessage[] = [
    { role: 'system', content: augmentSystemPrompt(config.systemPrompt, limits) },
    { role: 'user', content: prompt },
  ];
  const answer = await askModel(client, messages, config.requestTimeoutMs, limits, disableThinking);
  output.write(answer + '\n');
}

/** Интерактивный режим: диалог с сохранением истории. */
export async function runInteractive(
  client: ChatCompletionClient,
  config: AppConfig,
  limits: GenerationLimits,
  disableThinking: boolean,
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

  output.write(`Чат с моделью «${config.model}». Введите сообщение (выход — /exit или Ctrl+C).\n`);

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

      history.push({ role: 'user', content: userInput });
      try {
        const answer = await askModel(
          client,
          history,
          config.requestTimeoutMs,
          limits,
          disableThinking,
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

/** Результат разбора аргументов: промпт, ограничения и флаг отключения рассуждений. */
export interface ParsedArgs {
  prompt: string;
  limits: GenerationLimits;
  disableThinking: boolean;
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
    } else {
      throw new Error(`Неизвестный флаг: ${name}`);
    }
  }

  if (stops.length > 0) {
    limits.stop = stops.length === 1 ? stops[0] : stops;
  }

  return { prompt: promptParts.join(' ').trim(), limits, disableThinking };
}

/** Точка входа: выбирает режим работы по аргументам командной строки. */
export async function main(argv: string[], input: Readable, output: Writable): Promise<void> {
  const config = loadConfig();
  const client = new ChatCompletionClient(config);

  const { prompt, limits, disableThinking } = parseArgs(argv.slice(2));

  if (prompt) {
    await runOnce(client, config, prompt, limits, disableThinking, output);
  } else {
    await runInteractive(
      client,
      config,
      limits,
      disableThinking,
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
