import type { AppConfig } from './config.ts';
import type {
  ApiErrorResponse,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
} from './types.ts';

/** Опции одного запроса к модели. */
export interface CompleteOptions {
  /** Прерывание запроса (например, по таймауту). */
  signal?: AbortSignal;
}

/** Клиент для обращения к любому OpenAI-совместимому API chat/completions через fetch. */
export class ChatCompletionClient {
  private readonly config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
  }

  /**
   * Отправляет историю сообщений в модель и возвращает текст ответа.
   * Бросает ошибку при сетевом сбое или ответе с кодом ошибки.
   */
  async complete(messages: ChatMessage[], options: CompleteOptions = {}): Promise<string> {
    const body: ChatCompletionRequest = {
      model: this.config.model,
      messages,
      temperature: this.config.temperature,
      stream: false,
    };

    let response: Response;
    try {
      response = await fetch(this.config.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: options.signal,
      });
    } catch (cause) {
      // Прерывание по таймауту (TimeoutError) или отмену (AbortError)
      // пробрасываем как есть — вызывающий код различает их по name.
      if (
        cause instanceof Error &&
        (cause.name === 'TimeoutError' || cause.name === 'AbortError')
      ) {
        throw cause;
      }
      throw new Error(
        `Не удалось выполнить запрос к API (${this.config.baseUrl}): ` +
          `${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }

    if (!response.ok) {
      const message = await this.extractErrorMessage(response);
      throw new Error(`API вернул ошибку ${response.status} ${response.statusText}: ${message}`);
    }

    const data = (await response.json()) as ChatCompletionResponse;
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('API вернул пустой ответ без текста.');
    }

    return content;
  }

  /** Пытается достать осмысленное сообщение об ошибке из тела ответа. */
  private async extractErrorMessage(response: Response): Promise<string> {
    try {
      const data = (await response.json()) as ApiErrorResponse;
      return data.error?.message ?? 'неизвестная ошибка';
    } catch {
      return 'не удалось разобрать тело ответа';
    }
  }
}
