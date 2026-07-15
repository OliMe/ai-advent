import type { DiffFile } from './diff.ts';

/** Минимальный ответ HTTP (то, что нам нужно от fetch-Response). */
export interface HttpResponse {
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

/** Узкий контракт fetch (инжектируется для тестируемости). */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
  },
) => Promise<HttpResponse>;

/** Изменения PR/MR: метаданные + изменённые файлы (уже разобранные в DiffFile). */
export interface PullChanges {
  title: string;
  description: string;
  files: DiffFile[];
  /** Признак, что список файлов усечён (достигнут потолок страниц) — честно сообщаем. */
  truncated: boolean;
}

/** Одна инлайн-заметка: файл, строка новой версии и текст. */
export interface InlineComment {
  file: string;
  line: number;
  body: string;
}

/** Публикуемое ревью: сводный текст + инлайн-заметки. */
export interface ReviewPublication {
  summary: string;
  comments: InlineComment[];
}

/** Платформа хостинга: получить изменения PR и опубликовать ревью. */
export interface ReviewPlatform {
  fetchChanges(): Promise<PullChanges>;
  publish(review: ReviewPublication): Promise<void>;
}

/** Коды, при которых повтор осмыслен (перегрузка/временный сбой сервера). */
function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Опции HTTP-запроса к API платформы. */
export interface RequestOptions {
  fetchFn: FetchLike;
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  maxRetries: number;
  retryBaseMs: number;
  /** Пауза между попытками (инжектируется — в тестах мгновенная). */
  sleep: (ms: number) => Promise<void>;
}

/**
 * HTTP-запрос к API платформы с ретраями (429/5xx/сеть) и таймаутом — по образцу
 * `core/chat-completion-client.ts`. JSON-тело сериализуется, ответ парсится как JSON. Не-2xx после
 * исчерпания попыток → ошибка с телом (для диагностики). `fetch`/пауза инжектируются (тестируемо).
 */
export async function requestJson(options: RequestOptions): Promise<unknown> {
  let attempt = 0;
  for (;;) {
    try {
      const response = await options.fetchFn(options.url, {
        method: options.method,
        headers: options.headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      if (response.ok) {
        return response.status === 204 ? null : await response.json();
      }
      if (isRetryable(response.status) && attempt < options.maxRetries) {
        attempt++;
        await options.sleep(options.retryBaseMs * 2 ** (attempt - 1));
        continue;
      }
      const detail = await response.text().catch(() => '');
      throw new Error(
        `${options.method} ${options.url} → ${response.status} ${response.statusText}: ${detail}`,
      );
    } catch (error) {
      // Сетевой сбой (не HTTP-ответ) — повторяем; таймаут/исчерпание попыток пробрасываем.
      const isHttpError = error instanceof Error && error.message.includes(' → ');
      if (isHttpError || attempt >= options.maxRetries) {
        throw error;
      }
      attempt++;
      await options.sleep(options.retryBaseMs * 2 ** (attempt - 1));
    }
  }
}
