import type { AppConfig } from './config.ts';
import type {
  ApiErrorResponse,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  GenerationLimits,
  Usage,
} from './types.ts';

/** Ответ модели вместе со статистикой токенов (usage может отсутствовать). */
export interface CompletionResult {
  content: string;
  usage?: Usage;
}

/** Опции одного запроса к модели: прерывание плюс ограничения генерации. */
export interface CompleteOptions extends GenerationLimits {
  /** Прерывание запроса (например, по таймауту). */
  signal?: AbortSignal;
  /** Отключить «рассуждения» модели (экономит токены; нужно для стоп-маркеров на GLM). */
  disableThinking?: boolean;
  /** Температура для этого запроса; если не задана — берётся из конфигурации. */
  temperature?: number;
}

/** Стоит ли повторять запрос при таком HTTP-статусе (rate limit и ошибки сервера). */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Задержка перед повтором: учитывает заголовок Retry-After, иначе экспонента. */
function retryDelayMs(baseMs: number, attempt: number, response?: Response): number {
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
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
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
    return (await this.completeWithUsage(messages, options)).content;
  }

  /**
   * Как complete, но возвращает ещё и статистику токенов (usage), если провайдер
   * её прислал. Здесь же вся логика запроса и повторов.
   */
  async completeWithUsage(
    messages: ChatMessage[],
    options: CompleteOptions = {},
  ): Promise<CompletionResult> {
    const body: ChatCompletionRequest = {
      model: this.config.model,
      messages,
      temperature: options.temperature ?? this.config.temperature,
      stream: false,
    };
    // Ограничения добавляем только когда заданы — иначе провайдер берёт свои дефолты.
    if (options.maxTokens !== undefined) {
      body.max_tokens = options.maxTokens;
    }
    if (options.stop !== undefined) {
      // Некоторые провайдеры (например, z.ai) принимают stop только массивом —
      // нормализуем одиночную строку в массив для переносимости.
      body.stop = Array.isArray(options.stop) ? options.stop : [options.stop];
    }
    if (options.responseFormat !== undefined) {
      body.response_format = options.responseFormat;
    }
    if (options.disableThinking) {
      body.thinking = { type: 'disabled' };
    }

    // Повторяем при rate limit / ошибках сервера / сетевых сбоях с бэкоффом.
    // Исчерпание сетевых попыток выходит из цикла через break к throw ниже.
    let networkError!: Error;
    for (let attempt = 0; ; attempt++) {
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
        networkError = new Error(
          `Не удалось выполнить запрос к API (${this.config.baseUrl}): ` +
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
        const message = await this.extractErrorMessage(response);
        throw new Error(`API вернул ошибку ${response.status} ${response.statusText}: ${message}`);
      }

      const data = (await response.json()) as ChatCompletionResponse;
      const choice = data.choices?.[0];
      const content = choice?.message?.content;
      if (!content) {
        if (choice?.finish_reason === 'length') {
          throw new Error(
            'Ответ обрезан по лимиту max_tokens, видимого текста нет ' +
              '(модель израсходовала бюджет на рассуждения) — увеличьте лимит.',
          );
        }
        throw new Error('API вернул пустой ответ без текста.');
      }

      return { content, usage: data.usage };
    }
    throw networkError;
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
