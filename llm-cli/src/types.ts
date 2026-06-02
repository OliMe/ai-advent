/** Роль участника диалога в формате OpenAI-совместимого API. */
export type Role = 'system' | 'user' | 'assistant';

/** Одно сообщение в истории диалога. */
export interface ChatMessage {
  role: Role;
  content: string;
}

/** Тело запроса к эндпоинту chat/completions. */
export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
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
