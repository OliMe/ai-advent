import type { OcrConfig } from './config.ts';

/** Минимальный ответ HTTP, нужный клиенту (совместим с глобальным fetch). */
export interface HttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/** Узкий контракт fetch (инжектируется для тестируемости). */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<HttpResponse>;

/** Запрос на распознавание: изображение в base64 + параметры. */
export interface OcrRequest {
  content: string;
  mimeType: string;
  languageCodes: string[];
  model: string;
}

/** Результат распознавания. */
export interface OcrResult {
  fullText: string;
}

/** Безопасно достаёт поле объекта (или undefined для не-объектов). */
function pick(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** Извлекает сообщение об ошибке Yandex из тела ответа (несколько возможных форм). */
function describeError(json: unknown): string {
  const message = pick(json, 'message');
  if (typeof message === 'string') {
    return message;
  }
  const nested = pick(pick(json, 'error'), 'message');
  return typeof nested === 'string' ? nested : 'неизвестная ошибка';
}

/** Разбирает успешный ответ OCR: текст из result.textAnnotation.fullText. */
export function parseOcrResponse(json: unknown): OcrResult {
  const fullText = pick(pick(pick(json, 'result'), 'textAnnotation'), 'fullText');
  if (typeof fullText !== 'string') {
    throw new Error('Yandex OCR вернул ответ без распознанного текста.');
  }
  return { fullText };
}

/** Заголовки запроса: тип контента, авторизация и (опц.) каталог. */
function buildHeaders(config: OcrConfig): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: config.authorization,
    ...(config.folderId ? { 'x-folder-id': config.folderId } : {}),
  };
}

/** Вызывает синхронное распознавание текста Yandex OCR и возвращает распознанный текст. */
export async function recognizeText(
  fetchFn: FetchLike,
  config: OcrConfig,
  request: OcrRequest,
): Promise<OcrResult> {
  const response = await fetchFn(config.endpoint, {
    method: 'POST',
    headers: buildHeaders(config),
    body: JSON.stringify({
      mimeType: request.mimeType,
      languageCodes: request.languageCodes,
      model: request.model,
      content: request.content,
    }),
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  const json = await response.json();
  if (!response.ok) {
    throw new Error(`Yandex OCR ${response.status}: ${describeError(json)}`);
  }
  return parseOcrResponse(json);
}
