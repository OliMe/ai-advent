import type { ChatCompletionClient } from '../../core/src/index.ts';
import { modelUrl } from './hub.ts';

/** Модель, к которой делаем запрос (число параметров известно не всегда). */
export interface TargetModel {
  id: string;
  url: string;
  params?: number;
}

/** Результат запроса к одной модели: текст ответа либо ошибка. */
export interface ModelResult {
  model: TargetModel;
  text?: string;
  error?: string;
}

/** Фабрика клиента для конкретной модели (тот же провайдер, разный `model`). */
export type ClientFactory = (modelId: string) => ChatCompletionClient;

/** Строит цели из списка id (для моделей, заданных пользователем вручную). */
export function toTargets(ids: string[]): TargetModel[] {
  return ids.map(id => ({ id, url: modelUrl(id) }));
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
  return Promise.all(
    models.map(async model => {
      try {
        const signal = AbortSignal.timeout(requestTimeoutMs);
        const text = await makeClient(model.id).complete([{ role: 'user', content: prompt }], {
          signal,
        });
        return { model, text };
      } catch (error) {
        return { model, error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
}

/** Человекочитаемое число параметров: «7.6 B» или «751 M». */
export function formatParams(total: number): string {
  return total >= 1e9 ? `${(total / 1e9).toFixed(1)} B` : `${Math.round(total / 1e6)} M`;
}

/** Форматирует результаты: на каждую модель — id, размер, ссылка и ответ. */
export function formatResults(results: ModelResult[]): string {
  const separator = `\n\n${'─'.repeat(60)}\n\n`;
  const blocks = results.map(result => {
    const size = result.model.params !== undefined ? ` — ${formatParams(result.model.params)}` : '';
    const body = result.text !== undefined ? result.text : `[ошибка] ${result.error}`;
    return `### ${result.model.id}${size}\n${result.model.url}\n\n${body}`;
  });
  return `${blocks.join(separator)}\n`;
}
