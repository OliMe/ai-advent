import type { ChatCompletionClient, CompletionResult } from './chat-completion-client.ts';
import type { ChatMessage, GenerationLimits, Usage } from './types.ts';
import { historyBudgetTokens, trimHistoryToBudget } from './tokens.ts';

/**
 * Параметры одного диалога (агента), независимые от глобального конфига: каждый
 * агент задаёт их сам. Модель/провайдер — свойство переданного клиента.
 */
export interface ConversationConfig {
  /** Системный промпт (персона/инструкция); кладётся первым сообщением. */
  systemPrompt: string;
  temperature: number;
  /** Контекст модели агента — по нему история обрезается скользящим окном. */
  contextTokens: number;
  /** Таймаут запроса/простоя в мс. */
  requestTimeoutMs: number;
  disableThinking?: boolean;
  /** Ограничения генерации (max_tokens, stop, response_format и т.п.). */
  limits?: GenerationLimits;
}

/**
 * Переиспользуемый раннер диалога: держит транскрипт и за один `ask` шлёт окно
 * истории модели и возвращает ответ. Не привязан к CLI (нет readline/stdout) —
 * на нём строятся интерактив, этапы пайплайна и будущие субагенты. Стрим
 * отдаётся через колбэк `onDelta` (без спиннера — это забота вызывающего слоя).
 */
export class Conversation {
  private readonly client: ChatCompletionClient;
  private readonly config: ConversationConfig;
  /** Полный транскрипт диалога (для инспекции/персистентности). */
  readonly messages: ChatMessage[];
  private readonly accumulated: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  constructor(client: ChatCompletionClient, config: ConversationConfig) {
    this.client = client;
    this.config = config;
    this.messages = [{ role: 'system', content: config.systemPrompt }];
  }

  /** Суммарный расход токенов за все `ask` (для бюджетов/наблюдаемости). */
  get totals(): Usage {
    return { ...this.accumulated };
  }

  /**
   * Один ход: добавляет реплику пользователя, шлёт окно истории модели, добавляет
   * ответ в транскрипт и возвращает его. При `onDelta` идёт в потоковом режиме
   * (видимый текст — по кускам). При ошибке откатывает добавленную реплику.
   */
  async ask(userInput: string, onDelta?: (text: string) => void): Promise<CompletionResult> {
    this.messages.push({ role: 'user', content: userInput });
    const windowed = trimHistoryToBudget(
      this.messages,
      historyBudgetTokens(this.config.contextTokens, this.config.limits?.maxTokens),
    );
    try {
      const result = onDelta
        ? await this.client.streamWithUsage(
            windowed,
            {
              idleTimeoutMs: this.config.requestTimeoutMs,
              disableThinking: this.config.disableThinking,
              temperature: this.config.temperature,
              ...this.config.limits,
            },
            delta => {
              if (delta.content) {
                onDelta(delta.content);
              }
            },
          )
        : await this.client.completeWithUsage(windowed, {
            signal: AbortSignal.timeout(this.config.requestTimeoutMs),
            disableThinking: this.config.disableThinking,
            temperature: this.config.temperature,
            ...this.config.limits,
          });
      this.messages.push({ role: 'assistant', content: result.content });
      if (result.usage !== undefined) {
        this.accumulated.prompt_tokens += result.usage.prompt_tokens;
        this.accumulated.completion_tokens += result.usage.completion_tokens;
        this.accumulated.total_tokens += result.usage.total_tokens;
      }
      return result;
    } catch (error) {
      this.messages.pop(); // откатываем неудачный ход — транскрипт остаётся согласованным
      throw error;
    }
  }
}
