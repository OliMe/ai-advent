import type {
  AppConfig,
  ChatMessage,
  CompleteOptions,
  CompletionResult,
  StreamDelta,
} from '../../core/src/index.ts';
import { estimateTokens } from '../../core/src/index.ts';
import { describeAnswerCost, type AnswerCost } from './answer-cost.ts';
import type { GatewayConfig } from './config.ts';
import { formatFoodRefusal, type FoodVerdict } from './food-guard.ts';
import type { Persona } from './personas.ts';
import type { RequestQueue } from './request-queue.ts';

/** Отказ: запрос длиннее, чем узел готов обрабатывать. */
export class PromptTooLargeError extends Error {
  constructor(promptTokens: number, maxPromptTokens: number) {
    super(
      `Запрос слишком длинный: ${promptTokens} токенов при потолке ${maxPromptTokens}. ` +
        'Обработка промпта на CPU идёт ~30 токенов/с — длинный запрос ждать неразумно.',
    );
    this.name = 'PromptTooLargeError';
  }
}

/** Минимум от клиента модели, который нужен шлюзу (для подмены в тестах). */
export interface StreamingChatClient {
  streamWithUsage(
    messages: ChatMessage[],
    options: CompleteOptions,
    onDelta: (delta: StreamDelta) => void,
  ): Promise<CompletionResult>;
}

/** Что происходит с запросом по ходу обслуживания. */
export interface ChatHandlers {
  /** Запрос поставлен в очередь: столько ждут впереди него. */
  onQueued(waitingAhead: number): void;
  /** Очередная порция текста. */
  onDelta(text: string): void;
}

/** Итог обслуженного запроса. */
export interface ChatOutcome {
  content: string;
  /** Отказ гейта: запрос не про еду, рецепт не генерировался. */
  refused: boolean;
  /** Ценник ответа; при отказе гейта отсутствует (рецепт не считался). */
  cost?: AnswerCost;
}

/** Зависимости сервиса — всё внешнее инжектируется. */
export interface ChatServiceDeps {
  config: GatewayConfig;
  queue: RequestQueue;
  createClient: (model: string) => StreamingChatClient;
  /** Гейт съедобности: решает, готовить рецепт или отказать. */
  assessFood: (model: string, userMessage: string) => Promise<FoodVerdict>;
  now: () => number;
}

/**
 * Собирает конфигурацию апстрима под конкретную модель. Ollama ключ не проверяет,
 * но OpenAI-совместимые клиенты требуют заголовок — отсюда заглушка.
 */
export function createUpstreamConfig(config: GatewayConfig, model: string): AppConfig {
  return {
    apiKey: 'ollama',
    baseUrl: config.upstreamBaseUrl,
    model,
    temperature: 0.7,
    systemPrompt: '',
    requestTimeoutMs: config.requestTimeoutMs,
    contextTokens: 8192,
    maxRetries: 1,
    retryBaseMs: 500,
    priceInputPer1M: 0,
    priceOutputPer1M: 0,
    usdToRub: 0,
    maxStageAgents: 1,
    stageAgentConcurrency: 1,
    maxToolRounds: 1,
    structuredOutputs: false,
  };
}

/**
 * Сервис одного хода: проверяет длину запроса, ставит его в очередь (модель на CPU считает
 * по одному запросу) и стримит ответ, попутно измеряя, во что он обошёлся.
 */
export class ChatService {
  private readonly deps: ChatServiceDeps;

  constructor(deps: ChatServiceDeps) {
    this.deps = deps;
  }

  /** Обслуживает один запрос к персоне, отдавая текст порциями через handlers. */
  async respond(
    persona: Persona,
    userMessage: string,
    handlers: ChatHandlers,
  ): Promise<ChatOutcome> {
    const promptTokens = estimateTokens(userMessage);
    if (promptTokens > this.deps.config.maxPromptTokens) {
      throw new PromptTooLargeError(promptTokens, this.deps.config.maxPromptTokens);
    }

    return this.deps.queue.run(async waitingAhead => {
      handlers.onQueued(waitingAhead);

      // Гейт съедобности до генерации: посторонний запрос до рецепта не доходит.
      const verdict = await this.deps.assessFood(persona.model, userMessage);
      if (!verdict.edible) {
        const refusal = formatFoodRefusal(verdict.reason);
        handlers.onDelta(refusal);
        return { content: refusal, refused: true };
      }

      const messages: ChatMessage[] = [
        { role: 'system', content: persona.systemPrompt },
        { role: 'user', content: userMessage },
      ];

      const startedAtMs = this.deps.now();
      let firstDeltaAtMs: number | undefined;
      let lastDeltaAtMs = startedAtMs;

      const client = this.deps.createClient(persona.model);
      const result = await client.streamWithUsage(
        messages,
        { temperature: persona.temperature, maxTokens: persona.maxTokens },
        delta => {
          if (delta.content !== undefined) {
            lastDeltaAtMs = this.deps.now();
            firstDeltaAtMs ??= lastDeltaAtMs;
            handlers.onDelta(delta.content);
          }
        },
      );
      const finishedAtMs = this.deps.now();

      // Ответ без единой дельты: считаем, что первый токен так и не пришёл.
      const firstTokenAtMs = firstDeltaAtMs ?? finishedAtMs;
      const generatedTokens = result.usage?.completion_tokens ?? estimateTokens(result.content);
      const cost = describeAnswerCost(
        {
          wallMilliseconds: finishedAtMs - startedAtMs,
          timeToFirstTokenMilliseconds: firstTokenAtMs - startedAtMs,
          generationMilliseconds: lastDeltaAtMs - firstTokenAtMs,
        },
        this.deps.config.quotaCores,
        generatedTokens,
      );
      return { content: result.content, refused: false, cost };
    });
  }
}
