import * as readline from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import { loadConfig } from './config.ts';
import type { AppConfig } from './config.ts';
import { ChatCompletionClient } from './chat-completion-client.ts';
import type { ChatMessage } from './types.ts';

/** Метка ответа модели в интерактивном режиме. */
const ASSISTANT_LABEL = 'Ассистент';

/** Запускает один запрос с таймаутом и возвращает ответ модели. */
export async function askModel(
  client: ChatCompletionClient,
  messages: ChatMessage[],
  requestTimeoutMs: number,
): Promise<string> {
  // AbortSignal.timeout даёт при срабатывании TimeoutError — его легко
  // отличить от AbortError, который возникает при отмене пользователем.
  const signal = AbortSignal.timeout(requestTimeoutMs);
  return client.complete(messages, { signal });
}

/** Режим одного запроса: промпт передан аргументами командной строки. */
export async function runOnce(
  client: ChatCompletionClient,
  config: AppConfig,
  prompt: string,
  output: Writable,
): Promise<void> {
  const messages: ChatMessage[] = [
    { role: 'system', content: config.systemPrompt },
    { role: 'user', content: prompt },
  ];
  const answer = await askModel(client, messages, config.requestTimeoutMs);
  output.write(answer + '\n');
}

/** Интерактивный режим: диалог с сохранением истории. */
export async function runInteractive(
  client: ChatCompletionClient,
  config: AppConfig,
  input: Readable,
  output: Writable,
  // Передаётся явно — это же даёт тестам шов для подмены интерфейса.
  createInterface: typeof readline.createInterface,
): Promise<void> {
  const readlineInterface = createInterface({ input, output });
  const history: ChatMessage[] = [{ role: 'system', content: config.systemPrompt }];

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
        const answer = await askModel(client, history, config.requestTimeoutMs);
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

/** Точка входа: выбирает режим работы по аргументам командной строки. */
export async function main(argv: string[], input: Readable, output: Writable): Promise<void> {
  const config = loadConfig();
  const client = new ChatCompletionClient(config);

  // Всё, что после имени скрипта, считаем единым промптом.
  const prompt = argv.slice(2).join(' ').trim();

  if (prompt) {
    await runOnce(client, config, prompt, output);
  } else {
    await runInteractive(client, config, input, output, readline.createInterface);
  }
}

/** Сообщает о неперехваченной ошибке и помечает запуск как неуспешный. */
export function reportFatalError(error: unknown): void {
  console.error(`Ошибка: ${describeError(error)}`);
  process.exitCode = 1;
}
