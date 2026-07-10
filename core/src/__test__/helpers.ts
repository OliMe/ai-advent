import type { TestContext } from 'node:test';
import { ChatCompletionClient } from '../chat-completion-client.ts';
import type { CompleteOptions, CompletionResult, StreamDelta } from '../chat-completion-client.ts';
import type { AppConfig } from '../config.ts';
import type { ChatMessage } from '../types.ts';

/** Строит конфиг приложения с разумными значениями по умолчанию для тестов. */
export function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    apiKey: 'test-key',
    baseUrl: 'https://example.test/v1/chat/completions',
    model: 'test-model',
    temperature: 0.7,
    systemPrompt: 'Ты — ассистент.',
    requestTimeoutMs: 60_000,
    maxRetries: 0,
    retryBaseMs: 1,
    contextTokens: 8192,
    priceInputPer1M: 0,
    priceOutputPer1M: 0,
    usdToRub: 90,
    maxStageAgents: 1,
    stageAgentConcurrency: 2,
    maxToolRounds: 12,
    structuredOutputs: false,
    ...overrides,
  };
}

/** Строит успешный ответ chat/completions с заданным текстом ассистента. */
export function completionResponse(content: string): Response {
  const body = { choices: [{ index: 0, message: { role: 'assistant', content } }] };
  return new Response(JSON.stringify(body), { status: 200 });
}

/**
 * Строит потоковый (SSE) ответ из заданных кусков. Куски передаются как есть —
 * это позволяет в тестах рвать SSE-строки на границах чтения.
 */
export function streamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

/** Клиент с подменённым completeWithUsage (используется в не-стрим режиме). */
export function clientWith(
  t: TestContext,
  impl: (
    messages: ChatMessage[],
    options: CompleteOptions,
  ) => Promise<CompletionResult> | CompletionResult,
): ChatCompletionClient {
  const client = new ChatCompletionClient(makeConfig());
  t.mock.method(client, 'completeWithUsage', impl);
  return client;
}

/**
 * Клиент с подменённым streamWithUsage: impl(messages, options) даёт полный текст
 * ответа, который отдаётся одной content-дельтой; capture видит опции запроса.
 */
export function clientWithStream(
  t: TestContext,
  impl: (messages: ChatMessage[], options: CompleteOptions) => Promise<string> | string,
  capture?: (messages: ChatMessage[], options: CompleteOptions) => void,
): ChatCompletionClient {
  const client = new ChatCompletionClient(makeConfig());
  t.mock.method(
    client,
    'streamWithUsage',
    async (
      messages: ChatMessage[],
      options: CompleteOptions,
      onDelta: (delta: StreamDelta) => void,
    ) => {
      capture?.(messages, options);
      const content = await impl(messages, options);
      onDelta({ content });
      return { content, usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } };
    },
  );
  return client;
}
