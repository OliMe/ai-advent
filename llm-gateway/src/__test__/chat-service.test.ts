import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  ChatMessage,
  CompleteOptions,
  CompletionResult,
  StreamDelta,
} from '../../../core/src/index.ts';
import {
  ChatService,
  PromptTooLargeError,
  createUpstreamConfig,
  type ChatServiceDeps,
  type StreamingChatClient,
} from '../chat-service.ts';
import { loadGatewayConfig, type GatewayConfig } from '../config.ts';
import { DEFAULT_PERSONA } from '../personas.ts';
import { RequestQueue } from '../request-queue.ts';

/** Клиент-заглушка: отдаёт заданные дельты и результат, запоминая опции вызова. */
function fakeClient(deltas: StreamDelta[], result: CompletionResult) {
  const seenOptions: CompleteOptions[] = [];
  const client: StreamingChatClient = {
    async streamWithUsage(
      _messages: ChatMessage[],
      options: CompleteOptions,
      onDelta: (delta: StreamDelta) => void,
    ): Promise<CompletionResult> {
      seenOptions.push(options);
      deltas.forEach(onDelta);
      return result;
    },
  };
  return { client, seenOptions };
}

/** Гейт-заглушка: по умолчанию пропускает всё как съедобное. */
function allowAllFood() {
  return async () => ({ edible: true, reason: '' });
}

/** Собирает сервис на управляемых часах: каждый вызов now() двигает время на 5 секунд. */
function buildService(
  client: StreamingChatClient,
  overrides: Partial<GatewayConfig> = {},
  assessFood: ChatServiceDeps['assessFood'] = allowAllFood(),
) {
  const config = { ...loadGatewayConfig({}), ...overrides };
  let currentTimeMs = 0;
  return new ChatService({
    config,
    queue: new RequestQueue(config.maxQueueDepth),
    createClient: () => client,
    assessFood,
    now: () => {
      currentTimeMs += 5000;
      return currentTimeMs;
    },
  });
}

/** Собирает всё, что сервис сообщил по ходу обслуживания. */
function recordingHandlers() {
  const queued: number[] = [];
  const chunks: string[] = [];
  return {
    queued,
    chunks,
    handlers: {
      onQueued: (waitingAhead: number) => queued.push(waitingAhead),
      onDelta: (text: string) => chunks.push(text),
    },
  };
}

test('слишком длинный запрос отклоняется до постановки в очередь', async () => {
  const { client } = fakeClient([], { content: '' });
  const service = buildService(client, { maxPromptTokens: 1 });
  const { handlers, queued } = recordingHandlers();
  await assert.rejects(
    () => service.respond(DEFAULT_PERSONA, 'список продуктов длиннее одного токена', handlers),
    PromptTooLargeError,
  );
  assert.deepEqual(queued, []);
});

test('ответ стримится, позиция сообщается, usage даёт число токенов', async () => {
  const { client } = fakeClient(
    [{ content: 'Блюдо: ' }, { reasoning: 'размышляю' }, { content: 'омлет.' }],
    {
      content: 'Блюдо: омлет.',
      usage: { prompt_tokens: 10, completion_tokens: 60, total_tokens: 70 },
    },
  );
  const service = buildService(client);
  const { handlers, queued, chunks } = recordingHandlers();

  const outcome = await service.respond(DEFAULT_PERSONA, 'яйца, лук', handlers);

  assert.deepEqual(queued, [0]);
  assert.deepEqual(chunks, ['Блюдо: ', 'омлет.']);
  assert.equal(outcome.content, 'Блюдо: омлет.');
  assert.equal(outcome.refused, false);
  assert.ok(outcome.cost);
  assert.equal(outcome.cost.generatedTokens, 60);
  // Часы шагают по 5 с: старт 5, дельты 10 и 15, финиш 20.
  assert.equal(outcome.cost.wallSeconds, 15);
  assert.equal(outcome.cost.timeToFirstTokenSeconds, 5);
  assert.equal(outcome.cost.tokensPerSecond, 12);
  assert.equal(outcome.cost.cpuSeconds, 45);
});

test('несъедобный запрос: гейт отказывает, рецепт не генерируется', async () => {
  const { client, seenOptions } = fakeClient([{ content: 'НЕ ДОЛЖНО ПОЯВИТЬСЯ' }], {
    content: 'НЕ ДОЛЖНО ПОЯВИТЬСЯ',
  });
  const refuse = async () => ({ edible: false, reason: 'Гвозди несъедобны.' });
  const service = buildService(client, {}, refuse);
  const { handlers, queued, chunks } = recordingHandlers();

  const outcome = await service.respond(DEFAULT_PERSONA, 'молоток, гвозди', handlers);

  assert.deepEqual(queued, [0]);
  assert.equal(outcome.refused, true);
  assert.equal(outcome.cost, undefined);
  // Рецептурная модель НЕ вызывалась.
  assert.equal(seenOptions.length, 0);
  // Пользователь получил отказ с причиной, а не рецепт.
  assert.equal(chunks.length, 1);
  assert.match(chunks[0], /Гвозди несъедобны\./);
});

test('параметры генерации берутся из персоны', async () => {
  const { client, seenOptions } = fakeClient([{ content: 'ок' }], { content: 'ок' });
  const service = buildService(client);
  const { handlers } = recordingHandlers();
  await service.respond(DEFAULT_PERSONA, 'яйца', handlers);
  assert.equal(seenOptions[0].temperature, DEFAULT_PERSONA.temperature);
  assert.equal(seenOptions[0].maxTokens, DEFAULT_PERSONA.maxTokens);
});

test('без usage число токенов оценивается по длине ответа', async () => {
  const { client } = fakeClient([{ content: 'Коротко' }], { content: 'Коротко' });
  const service = buildService(client);
  const { handlers } = recordingHandlers();
  const outcome = await service.respond(DEFAULT_PERSONA, 'яйца', handlers);
  assert.ok(outcome.cost);
  assert.ok(outcome.cost.generatedTokens > 0);
});

test('ответ без единого текстового токена не ломает подсчёт времени', async () => {
  const { client } = fakeClient([{ reasoning: 'только мысли' }], { content: '' });
  const service = buildService(client);
  const { handlers, chunks } = recordingHandlers();
  const outcome = await service.respond(DEFAULT_PERSONA, 'яйца', handlers);
  assert.deepEqual(chunks, []);
  assert.ok(outcome.cost);
  assert.equal(outcome.cost.tokensPerSecond, 0);
  assert.equal(outcome.cost.timeToFirstTokenSeconds, outcome.cost.wallSeconds);
});

test('createUpstreamConfig подставляет модель персоны и адрес Ollama', () => {
  const config = loadGatewayConfig({});
  const upstream = createUpstreamConfig(config, 'qwen2.5:3b');
  assert.equal(upstream.model, 'qwen2.5:3b');
  assert.equal(upstream.baseUrl, config.upstreamBaseUrl);
  assert.equal(upstream.apiKey, 'ollama');
});
