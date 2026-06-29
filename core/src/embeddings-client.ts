import type { EmbeddingsConfig } from './config.ts';
import { isRetryableStatus, retryDelayMs, sleep } from './http-retry.ts';

/** Ответ OpenAI-совместимого `/embeddings`: вектор на элемент входа. */
interface EmbeddingsResponse {
  data?: { index: number; embedding: number[] }[];
}

/** Тело ошибки OpenAI-совместимого API. */
interface ErrorBody {
  error?: { message?: string };
}

/**
 * Клиент эмбеддингов для любого OpenAI-совместимого `/embeddings` (Ollama, OpenAI, z.ai, …).
 * Провод и конфиг одинаковы для всех — провайдер меняется через `EmbeddingsConfig` (URL/модель/ключ),
 * без изменений кода. Повторяет запрос при 429/5xx/сетевых сбоях (бэкофф), таймаут — на запрос.
 */
export class EmbeddingsClient {
  private readonly config: EmbeddingsConfig;

  constructor(config: EmbeddingsConfig) {
    this.config = config;
  }

  /**
   * Возвращает векторы для набора текстов в ИСХОДНОМ порядке (ответ сортируется по index).
   * Пустой вход — пустой результат (без обращения к сети).
   */
  async embed(inputs: string[]): Promise<number[][]> {
    if (inputs.length === 0) {
      return [];
    }
    const response = await this.performRequest(inputs);
    const data = ((await response.json()) as EmbeddingsResponse).data ?? [];
    return data
      .slice()
      .sort((first, second) => first.index - second.index)
      .map(item => item.embedding);
  }

  /** Выполняет запрос с повторами; прерывание по таймауту/отмене пробрасывает как есть. */
  private async performRequest(inputs: string[]): Promise<Response> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) {
      headers.Authorization = `Bearer ${this.config.apiKey}`;
    }
    const body = JSON.stringify({ model: this.config.model, input: inputs });
    let networkError!: Error;
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await fetch(this.config.url, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(this.config.requestTimeoutMs),
        });
      } catch (cause) {
        if (
          cause instanceof Error &&
          (cause.name === 'TimeoutError' || cause.name === 'AbortError')
        ) {
          throw cause;
        }
        networkError = new Error(
          `Не удалось выполнить запрос эмбеддингов (${this.config.url}): ` +
            `${cause instanceof Error ? cause.message : String(cause)}`,
          { cause },
        );
        if (attempt < this.config.maxRetries) {
          await sleep(retryDelayMs(this.config.retryBaseMs, attempt));
          continue;
        }
        break;
      }
      if (!response.ok) {
        if (isRetryableStatus(response.status) && attempt < this.config.maxRetries) {
          await sleep(retryDelayMs(this.config.retryBaseMs, attempt, response));
          continue;
        }
        throw new Error(
          `API эмбеддингов вернул ошибку ${response.status} ${response.statusText}: ` +
            `${await this.extractErrorMessage(response)}`,
        );
      }
      return response;
    }
    throw networkError;
  }

  /** Пытается достать осмысленное сообщение об ошибке из тела ответа. */
  private async extractErrorMessage(response: Response): Promise<string> {
    try {
      return ((await response.json()) as ErrorBody).error?.message ?? 'неизвестная ошибка';
    } catch {
      return 'не удалось разобрать тело ответа';
    }
  }
}
