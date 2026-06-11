import type { AppConfig } from '../config.ts';

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
