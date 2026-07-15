import type { ChatCompletionClient } from './chat-completion-client.ts';
import type { ChatMessage, JsonSchemaSpec } from './types.ts';
import { structuredLimits } from './pipeline-schemas.ts';
import { parseJsonObject } from './json.ts';

/**
 * Дублирование JSON-схемы текстом для system-промпта: мягкая деградация для провайдеров, которые
 * игнорируют `response_format` (z.ai/GLM его ломают). Даже без constrained decoding модель видит
 * форму ответа и старается её соблюсти, а толерантный парсер вынимает объект из прозы.
 */
export function schemaPromptEcho(schema: JsonSchemaSpec): string {
  return (
    'Ответь СТРОГО одним JSON-объектом по этой JSON Schema, без markdown-ограждения и без пояснений:\n' +
    JSON.stringify(schema.schema, null, 2)
  );
}

/** Параметры одноразовой структурированной задачи. */
export interface StructuredTaskOptions {
  /** JSON-схема ожидаемого объекта. */
  schema: JsonSchemaSpec;
  /**
   * Включён ли constrained decoding (`response_format`). По умолчанию выключено — как в остальном
   * ядре, потому что `response_format` ломает z.ai/GLM; тогда схему просим только промптом.
   */
  structuredOutputs?: boolean;
  /** Потолок токенов ответа. */
  maxTokens?: number;
  /** Стоп-последовательности. */
  stop?: string | string[];
  /** Температура (иначе — из конфига клиента). */
  temperature?: number;
  /** Гасит рассуждения (для reasoning-моделей/GLM). */
  disableThinking?: boolean;
  /** Таймаут запроса; преобразуется в `AbortSignal.timeout`. */
  requestTimeoutMs: number;
}

/**
 * Одноразовая структурированная LLM-задача: «сообщения → один запрос → разобранный JSON-объект».
 * Переиспользуемый примитив (раньше был зашит в contract-extractor). Собирает ограничения через
 * `structuredLimits` (схема идёт в `response_format`, только если включён тумблер), делает один
 * `client.complete` с таймаутом и разбирает ответ толерантным `parseJsonObject` — устойчиво к обёртке
 * прозой/markdown и безопасно для провайдеров без поддержки схем. Не разобрался → бросает говорящую
 * ошибку (просьба поднять maxTokens / выключить thinking). Вызывающий приводит объект к своему типу.
 */
export async function completeStructured(
  client: ChatCompletionClient,
  messages: ChatMessage[],
  options: StructuredTaskOptions,
): Promise<Record<string, unknown>> {
  const limits = structuredLimits(options.structuredOutputs, options.schema) ?? {};
  const content = await client.complete(messages, {
    signal: AbortSignal.timeout(options.requestTimeoutMs),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.disableThinking ? { disableThinking: true } : {}),
    ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    ...(options.stop === undefined ? {} : { stop: options.stop }),
    ...limits,
  });
  const parsed = parseJsonObject(content);
  if (parsed === null) {
    throw new Error(
      'Не удалось разобрать JSON из ответа модели. Увеличьте maxTokens или отключите thinking ' +
        '(--no-thinking); проверьте, что модель возвращает объект по схеме.',
    );
  }
  return parsed;
}
