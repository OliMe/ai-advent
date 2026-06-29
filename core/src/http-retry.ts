/**
 * Общие помощники повторов HTTP-запросов (rate limit / ошибки сервера / сетевые сбои).
 * Используются клиентами chat/completions и embeddings — логика повторов одна.
 */

/** Стоит ли повторять запрос при таком HTTP-статусе (rate limit и ошибки сервера). */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Задержка перед повтором: учитывает заголовок Retry-After, иначе экспонента. */
export function retryDelayMs(baseMs: number, attempt: number, response?: Response): number {
  if (response) {
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter !== null) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds)) {
        return seconds * 1000;
      }
    }
  }
  return baseMs * 2 ** attempt;
}

/** Пауза заданной длительности. */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
