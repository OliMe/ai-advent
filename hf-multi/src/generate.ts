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

/** Прерывание по таймауту/отмене — повторять другой маршрут смысла нет. */
function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

/**
 * Запрашивает одну модель, пробуя маршруты по очереди: сначала закреплённый
 * провайдер (`<id>:<provider>`), затем голый id (router выберет сам). Разные
 * аккаунты принимают разные маршруты, поэтому используем первый рабочий.
 */
async function generateOne(
  makeClient: ClientFactory,
  model: TargetModel,
  prompt: string,
  requestTimeoutMs: number,
): Promise<ModelResult> {
  const startedAt = Date.now();
  const routes = model.apiId === model.id ? [model.apiId] : [model.apiId, model.id];
  let lastError: unknown;
  for (const route of routes) {
    try {
      const { content, usage } = await makeClient(route).completeWithUsage(
        [{ role: 'user', content: prompt }],
        { signal: AbortSignal.timeout(requestTimeoutMs) },
      );
      return { model, text: content, usage, elapsedMs: Date.now() - startedAt };
    } catch (error) {
      lastError = error;
      if (isAbort(error)) {
        break;
      }
    }
  }
  return {
    model,
    error: lastError instanceof Error ? lastError.message : String(lastError),
    elapsedMs: Date.now() - startedAt,
  };
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
): Promise<ModelResult[]> {
  return Promise.all(models.map(model => generateOne(makeClient, model, prompt, requestTimeoutMs)));
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
