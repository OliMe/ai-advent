/** Роль участника диалога в формате OpenAI-совместимого API. */
export type Role = 'system' | 'user' | 'assistant';

/** Одно сообщение в истории диалога. */
export interface ChatMessage {
  role: Role;
  content: string;
}

/** Описание строгой JSON-схемы для структурированного ответа. */
export interface JsonSchemaSpec {
  name: string;
  strict?: boolean;
  schema: Record<string, unknown>;
}

/**
 * Требуемый формат ответа модели:
 * - `text` — обычный текст (по умолчанию);
 * - `json_object` — любой синтаксически валидный JSON;
 * - `json_schema` — JSON, строго соответствующий заданной схеме.
 */
export type ResponseFormat =
  | { type: 'text' }
  | { type: 'json_object' }
  | { type: 'json_schema'; json_schema: JsonSchemaSpec };

/**
 * Необязательные ограничения генерации, задаваемые на конкретный запрос.
 * Любое поле, оставленное undefined, в запрос не попадает — провайдер берёт
 * собственное значение по умолчанию.
 */
export interface GenerationLimits {
  /** Максимальное число токенов в ответе. */
  maxTokens?: number;
  /** Стоп-последовательность(и): генерация прекращается на первой встреченной. */
  stop?: string | string[];
  /** Формат ответа (например, строгий JSON). */
  responseFormat?: ResponseFormat;
}

/** Тело запроса к эндпоинту chat/completions. */
export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stop?: string | string[];
  response_format?: ResponseFormat;
  stream?: boolean;
  /** Управление «рассуждениями» (специфично для GLM/z.ai; другие провайдеры игнорируют). */
  thinking?: { type: 'enabled' | 'disabled' };
}

/** Один вариант ответа модели (не потоковый режим). */
export interface ChatCompletionChoice {
  index: number;
  message: ChatMessage;
  finish_reason: string | null;
}

/** Статистика использования токенов. */
export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/** Полный ответ эндпоинта chat/completions (не потоковый режим). */
export interface ChatCompletionResponse {
  id: string;
  model: string;
  created: number;
  choices: ChatCompletionChoice[];
  usage?: Usage;
}

/** Структура ошибки, возвращаемая API. */
export interface ApiErrorResponse {
  error?: {
    code?: string;
    message?: string;
  };
}
