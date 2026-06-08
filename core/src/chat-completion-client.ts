import type { AppConfig } from './config.ts';
import type {
  ApiErrorResponse,
  ChatCompletionChunk,
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

/** Порция потокового ответа: дельта видимого текста и/или «рассуждений». */
export interface StreamDelta {
  /** Дельта видимого ответа. */
  content?: string;
  /** Дельта «рассуждений» (reasoning_content) — у reasoning-моделей. */
  reasoning?: string;
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

/** Сообщение об ответе, обрезанном по лимиту до появления видимого текста. */
const TRUNCATED_BY_LENGTH_MESSAGE =
  'Ответ обрезан по лимиту max_tokens, видимого текста нет ' +
  '(модель израсходовала бюджет на рассуждения) — увеличьте лимит.';
/** Сообщение о пустом ответе без текста. */
const EMPTY_RESPONSE_MESSAGE = 'API вернул пустой ответ без текста.';

/** Ошибка для ответа без видимого текста: обрезка по лимиту либо пустой ответ. */
function emptyContentError(finishReason: string | null | undefined): Error {
  return new Error(finishReason === 'length' ? TRUNCATED_BY_LENGTH_MESSAGE : EMPTY_RESPONSE_MESSAGE);
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
   * её прислал.
   */
  async completeWithUsage(
    messages: ChatMessage[],
    options: CompleteOptions = {},
  ): Promise<CompletionResult> {
    const response = await this.performRequest(
      this.buildRequestBody(messages, options, false),
      options.signal,
    );
    const data = (await response.json()) as ChatCompletionResponse;
    const choice = data.choices?.[0];
    const content = choice?.message?.content;
    if (!content) {
      throw emptyContentError(choice?.finish_reason);
    }
    return { content, usage: data.usage };
  }

  /**
   * Потоковый вариант: текст приходит частями в onDelta (видимый ответ и/или
   * «рассуждения» reasoning-моделей), а по завершении возвращается полный текст
   * и usage. Повтор при сбоях возможен только до начала чтения потока —
   * частично отданный поток не переигрываем.
   */
  async streamWithUsage(
    messages: ChatMessage[],
    options: CompleteOptions,
    onDelta: (delta: StreamDelta) => void,
  ): Promise<CompletionResult> {
    const response = await this.performRequest(
      this.buildRequestBody(messages, options, true),
      options.signal,
    );
    if (!response.body) {
      throw new Error(EMPTY_RESPONSE_MESSAGE);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let usage: Usage | undefined;
    let finishReason: string | null | undefined;

    let streaming = true;
    while (streaming) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      // SSE-события разделены переводами строк; обрабатываем полные строки,
      // незавершённый «хвост» остаётся в буфере до следующего чтения.
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf('\n');
        if (!line.startsWith('data:')) {
          continue;
        }
        const payload = line.slice('data:'.length).trim();
        if (payload === '[DONE]') {
          streaming = false;
          break;
        }
        const chunk = JSON.parse(payload) as ChatCompletionChunk;
        const choice = chunk.choices?.[0];
        if (choice?.delta?.reasoning_content) {
          onDelta({ reasoning: choice.delta.reasoning_content });
        }
        if (choice?.delta?.content) {
          content += choice.delta.content;
          onDelta({ content: choice.delta.content });
        }
        if (choice?.finish_reason) {
          finishReason = choice.finish_reason;
        }
        if (chunk.usage) {
          usage = chunk.usage;
        }
      }
    }

    if (!content) {
      throw emptyContentError(finishReason);
    }
    return { content, usage };
  }

  /** Собирает тело запроса из сообщений и ограничений генерации. */
  private buildRequestBody(
    messages: ChatMessage[],
    options: CompleteOptions,
    stream: boolean,
  ): ChatCompletionRequest {
    const body: ChatCompletionRequest = {
      model: this.config.model,
      messages,
      temperature: options.temperature ?? this.config.temperature,
      stream,
    };
    // include_usage просит провайдера прислать usage в финальном чанке потока.
    if (stream) {
      body.stream_options = { include_usage: true };
    }
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
    return body;
  }

  /**
   * Выполняет запрос с повторами (rate limit / ошибки сервера / сетевые сбои) и
   * возвращает успешный ответ. Прерывание по таймауту/отмене пробрасывает как есть.
   */
  private async performRequest(
    body: ChatCompletionRequest,
    signal?: AbortSignal,
  ): Promise<Response> {
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
          signal,
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

      return response;
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
