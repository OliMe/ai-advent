import type { ChatCompletionClient, Usage } from '../../core/src/index.ts';
import { modelUrl, type HfModel } from './hub.ts';

/** Модель, к которой делаем запрос (число параметров известно не всегда). */
export interface TargetModel {
  /** id для router'а (может быть `<id>:<provider>`). */
  apiId: string;
  /** Отображаемый id (без провайдера). */
  id: string;
  url: string;
  params?: number;
}

/** Результат запроса к одной модели: текст ответа либо ошибка, плюс метрики. */
export interface ModelResult {
  model: TargetModel;
  text?: string;
  error?: string;
  /** Время ответа, мс (замеряется и при успехе, и при ошибке). */
  elapsedMs: number;
  /** Статистика токенов, если провайдер её прислал. */
  usage?: Usage;
}

/** Фабрика клиента для конкретной модели (тот же провайдер, разный `model`). */
export type ClientFactory = (modelId: string) => ChatCompletionClient;

/**
 * Строит цели из списка, заданного пользователем. Допускается суффикс провайдера
 * (`owner/model:provider`): он уходит в router как есть, а в отображении и ссылке
 * показывается чистый id.
 */
export function toTargets(ids: string[]): TargetModel[] {
  return ids.map(apiId => {
    const id = apiId.split(':')[0];
    return { apiId, id, url: modelUrl(id) };
  });
}

/** Преобразует отобранные модели HF в цели, закрепляя провайдера в id для router'а. */
export function fromHfModels(models: HfModel[]): TargetModel[] {
  return models.map(model => ({
    apiId: `${model.id}:${model.provider}`,
    id: model.id,
    url: model.url,
    params: model.params,
  }));
}

/** Сколько раз повторить запрос после сбоя: холодный старт и блипы провайдера лечатся повтором. */
const RETRY_LIMIT = 1;

/**
 * Дефолтный потолок длины ответа. Без явного max_tokens некоторые провайдеры
 * подставляют 0 и падают на проверке контекста («max_tokens=0 … exceeds»).
 * Значение с запасом влезает в контекст моделей даже на 4096 токенов;
 * переопределяется флагом --max-tokens.
 */
export const DEFAULT_MAX_TOKENS = 2048;

/** Результат-ошибка с замером времени. */
function errorResult(model: TargetModel, error: unknown, startedAt: number): ModelResult {
  return {
    model,
    error: error instanceof Error ? error.message : String(error),
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * Запрашивает одну модель закреплённым маршрутом (`<id>:<provider>`). При сбое —
 * таймаут на холодном старте или блип провайдера — повторяет тот же маршрут
 * (после прогрева/повтора обычно отвечает). На голый id не уходим: у router'а
 * без провайдера часто нет включённого провайдера, и это лишь маскирует реальную
 * ошибку пина — отдаём её как есть.
 */
async function generateOne(
  makeClient: ClientFactory,
  model: TargetModel,
  prompt: string,
  requestTimeoutMs: number,
  maxTokens: number,
): Promise<ModelResult> {
  const startedAt = Date.now();
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_LIMIT; attempt++) {
    try {
      const { content, usage } = await makeClient(model.apiId).completeWithUsage(
        [{ role: 'user', content: prompt }],
        { signal: AbortSignal.timeout(requestTimeoutMs), maxTokens },
      );
      return { model, text: content, usage, elapsedMs: Date.now() - startedAt };
    } catch (error) {
      lastError = error;
    }
  }
  return errorResult(model, lastError, startedAt);
}

/**
 * Запрашивает все модели параллельно. Ошибка одной модели не роняет остальные —
 * результат каждой содержит либо текст, либо сообщение об ошибке.
 */
export async function generateAll(
  makeClient: ClientFactory,
  models: TargetModel[],
  prompt: string,
  requestTimeoutMs: number,
  maxTokens: number = DEFAULT_MAX_TOKENS,
): Promise<ModelResult[]> {
  return Promise.all(
    models.map(model => generateOne(makeClient, model, prompt, requestTimeoutMs, maxTokens)),
  );
}

/** Человекочитаемое число параметров: «7.6 B» или «751 M». */
export function formatParams(total: number): string {
  return total >= 1e9 ? `${(total / 1e9).toFixed(1)} B` : `${Math.round(total / 1e6)} M`;
}

/** Строка метрик: время ответа и токены вход/выход/всего (если провайдер их прислал). */
export function formatStats(result: ModelResult): string {
  const seconds = `${(result.elapsedMs / 1000).toFixed(1)} c`;
  const tokens = result.usage
    ? `вход ${result.usage.prompt_tokens}, выход ${result.usage.completion_tokens}, ` +
      `всего ${result.usage.total_tokens}`
    : 'н/д';
  return `время: ${seconds} · токены: ${tokens}`;
}

/** Форматирует результаты: на каждую модель — id, размер, ссылка, метрики и ответ. */
export function formatResults(results: ModelResult[]): string {
  const separator = `\n\n${'─'.repeat(60)}\n\n`;
  const blocks = results.map(result => {
    const size = result.model.params !== undefined ? ` — ${formatParams(result.model.params)}` : '';
    const body = result.text !== undefined ? result.text : `[ошибка] ${result.error}`;
    return `### ${result.model.id}${size}\n${result.model.url}\n${formatStats(result)}\n\n${body}`;
  });
  return `${blocks.join(separator)}\n`;
}
