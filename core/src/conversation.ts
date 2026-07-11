import type { ChatCompletionClient, CompletionResult } from './chat-completion-client.ts';
import type { ChatMessage, GenerationLimits, ToolCall, Usage } from './types.ts';
import type { ToolSet } from './tool-set.ts';
import { historyBudgetTokens, trimHistoryToBudget } from './tokens.ts';

/** Максимум раундов «модель ↔ инструменты» за один `ask` (защита от зацикливания). */
const DEFAULT_MAX_TOOL_ROUNDS = 6;

/**
 * Параметры одного диалога (агента), независимые от глобального конфига: каждый
 * агент задаёт их сам. Модель/провайдер — свойство переданного клиента.
 */
export interface ConversationConfig {
  /** Системный промпт (персона/инструкция); кладётся первым сообщением. */
  systemPrompt: string;
  temperature: number;
  /**
   * Модель этого диалога; не задана — берётся из конфигурации клиента. Позволяет роли
   * (напр. этапу выполнения) идти на свою модель без отдельного клиента.
   */
  model?: string;
  /** Контекст модели агента — по нему история обрезается скользящим окном. */
  contextTokens: number;
  /** Таймаут запроса/простоя в мс. */
  requestTimeoutMs: number;
  disableThinking?: boolean;
  /** Ограничения генерации (max_tokens, stop, response_format и т.п.). */
  limits?: GenerationLimits;
  /**
   * Колбэк расхода токенов на каждый `ask` (если провайдер прислал usage). Нужен, чтобы
   * учитывать обращения вложенных агентов (этапы пайплайна, контролёр) в общем счёте сессии.
   */
  onUsage?: (usage: Usage) => void;
  /**
   * Набор инструментов агента (function-calling). Задан и непуст — `ask` идёт агентным
   * циклом: модель может вызывать инструменты, результаты возвращаются ей до финального ответа.
   */
  tools?: ToolSet;
  /** Максимум раундов вызова инструментов за `ask` (по умолчанию 6). */
  maxToolRounds?: number;
  /** Уведомление о вызове инструмента (имя + аргументы) — для наблюдаемости. */
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
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
   * Один ход: добавляет реплику пользователя и возвращает ответ модели. Без инструментов —
   * один запрос (с `onDelta` потоково). С инструментами — агентный цикл: модель может вызвать
   * инструменты, их результаты возвращаются ей до финального ответа. При ошибке весь ход
   * откатывается (транскрипт остаётся согласованным).
   */
  async ask(userInput: string, onDelta?: (text: string) => void): Promise<CompletionResult> {
    const mark = this.messages.length;
    this.messages.push({ role: 'user', content: userInput });
    try {
      return this.config.tools && this.config.tools.specs().length > 0
        ? await this.runWithTools()
        : await this.runOnce(onDelta);
    } catch (error) {
      this.messages.length = mark; // откатываем весь ход (реплика + tool-сообщения)
      throw error;
    }
  }

  /** Окно истории, обрезанное под контекст модели. */
  private windowed(): ChatMessage[] {
    return trimHistoryToBudget(
      this.messages,
      historyBudgetTokens(this.config.contextTokens, this.config.limits?.maxTokens),
    );
  }

  /** Учитывает расход токенов в итогах и колбэке наблюдаемости. */
  private accountUsage(usage: Usage | undefined): void {
    if (usage !== undefined) {
      this.accumulated.prompt_tokens += usage.prompt_tokens;
      this.accumulated.completion_tokens += usage.completion_tokens;
      this.accumulated.total_tokens += usage.total_tokens;
      this.config.onUsage?.(usage);
    }
  }

  /** Один запрос к модели (без инструментов): потоково при `onDelta`, иначе обычный. */
  private async runOnce(onDelta?: (text: string) => void): Promise<CompletionResult> {
    const result = onDelta
      ? await this.client.streamWithUsage(
          this.windowed(),
          {
            idleTimeoutMs: this.config.requestTimeoutMs,
            disableThinking: this.config.disableThinking,
            temperature: this.config.temperature,
            model: this.config.model,
            ...this.config.limits,
          },
          delta => {
            if (delta.content) {
              onDelta(delta.content);
            }
          },
        )
      : await this.client.completeWithUsage(this.windowed(), {
          signal: AbortSignal.timeout(this.config.requestTimeoutMs),
          disableThinking: this.config.disableThinking,
          temperature: this.config.temperature,
          model: this.config.model,
          ...this.config.limits,
        });
    this.messages.push({ role: 'assistant', content: result.content });
    this.accountUsage(result.usage);
    return result;
  }

  /** Агентный цикл: запрашивает модель с инструментами, исполняет вызовы, до финального ответа. */
  private async runWithTools(): Promise<CompletionResult> {
    const tools = this.config.tools!;
    const definitions = tools.specs().map(spec => ({
      type: 'function' as const,
      function: { name: spec.name, description: spec.description, parameters: spec.parameters },
    }));
    const maxRounds = this.config.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
    for (let round = 0; round < maxRounds; round++) {
      const result = await this.client.completeWithUsage(this.windowed(), {
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
        disableThinking: this.config.disableThinking,
        temperature: this.config.temperature,
        model: this.config.model,
        ...this.config.limits,
        tools: definitions,
      });
      this.accountUsage(result.usage);
      const toolCalls = result.toolCalls;
      if (!toolCalls?.length) {
        this.messages.push({ role: 'assistant', content: result.content });
        return result;
      }
      this.messages.push({ role: 'assistant', content: result.content, tool_calls: toolCalls });
      for (const call of toolCalls) {
        const output = await this.runToolCall(call);
        this.messages.push({ role: 'tool', tool_call_id: call.id, content: output });
      }
    }
    throw new Error(`Превышен лимит раундов вызова инструментов (${maxRounds}).`);
  }

  /** Исполняет один вызов инструмента; ошибку отдаёт текстом, чтобы модель могла её учесть. */
  private async runToolCall(call: ToolCall): Promise<string> {
    try {
      const args = (call.function.arguments ? JSON.parse(call.function.arguments) : {}) as Record<
        string,
        unknown
      >;
      this.config.onToolCall?.(call.function.name, args);
      return await this.config.tools!.call(call.function.name, args);
    } catch (error) {
      return `Ошибка инструмента «${call.function.name}»: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}
