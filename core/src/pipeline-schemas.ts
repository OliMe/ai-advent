import type { GenerationLimits, JsonSchemaSpec } from './types.ts';

/**
 * JSON-схемы структурированного вывода этапов пайплайна (constrained decoding).
 *
 * ВАЖНО (инвариант безопасности провайдеров). Схемы применяются ТОЛЬКО когда пользователь
 * явно поднял тумблер `LLM_STRUCTURED_OUTPUTS=1`. По умолчанию путь прежний: JSON просим
 * в промпте, ответ вынимаем толерантным парсером (`extractJsonObject`). Причина — z.ai/GLM
 * ломается на `response_format` (вырезает литерал «json»), поэтому провайдера НЕ детектим,
 * а отдаём решение пользователю: тумблер поднимают под модель, которая это умеет (Ollama).
 * Толерантный парсер остаётся фолбэком на обоих путях.
 */

/** Схема плана: шаги, критерии приёмки и краткий план словами. */
export const PLANNING_SCHEMA: JsonSchemaSpec = {
  name: 'planning_artifact',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      steps: { type: 'array', items: { type: 'string' } },
      criteria: { type: 'array', items: { type: 'string' } },
      text: { type: 'string' },
    },
    required: ['steps', 'criteria', 'text'],
  },
};

/** Схема вердикта проверки: признак прохождения, замечания и вывод. */
export const VERIFICATION_SCHEMA: JsonSchemaSpec = {
  name: 'verification_artifact',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      passed: { type: 'boolean' },
      issues: { type: 'array', items: { type: 'string' } },
      text: { type: 'string' },
    },
    required: ['passed', 'issues', 'text'],
  },
};

/** Схема завершения: итог одной фразой и итоговое резюме. */
export const COMPLETION_SCHEMA: JsonSchemaSpec = {
  name: 'completion_artifact',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      summary: { type: 'string' },
      text: { type: 'string' },
    },
    required: ['summary', 'text'],
  },
};

/**
 * Ограничения генерации со схемой — или `undefined`, когда структурированный вывод
 * выключен (тогда `makeConversation` получает прежний `undefined` и поведение
 * байт-в-байт совпадает с сегодняшним).
 */
export function structuredLimits(
  enabled: boolean | undefined,
  schema: JsonSchemaSpec,
): GenerationLimits | undefined {
  return enabled === true
    ? { responseFormat: { type: 'json_schema', json_schema: schema } }
    : undefined;
}
