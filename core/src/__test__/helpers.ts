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
    ...overrides,
  };
}

/** Строит успешный ответ chat/completions с заданным текстом ассистента. */
export function completionResponse(content: string): Response {
  const body = { choices: [{ index: 0, message: { role: 'assistant', content } }] };
  return new Response(JSON.stringify(body), { status: 200 });
}
