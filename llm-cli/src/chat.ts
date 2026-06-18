import type { Writable } from 'node:stream';
import { ChatCompletionClient } from '../../core/src/index.ts';
import type {
  AppConfig,
  ChatMessage,
  CompletionResult,
  GenerationLimits,
} from '../../core/src/index.ts';

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
