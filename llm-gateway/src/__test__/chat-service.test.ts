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
  type StreamingChatClient,
} from '../chat-service.ts';
import { loadGatewayConfig, type GatewayConfig } from '../config.ts';
import { findPersona } from '../personas.ts';
import { RequestQueue } from '../request-queue.ts';
import type { SystemMetrics } from '../system-metrics.ts';

const PERSONA = findPersona('grumpy')!;

/** Спокойный узел: чтобы настроение не мешало проверять механику сервиса. */
const IDLE_METRICS: SystemMetrics = {
  cpuIdlePercent: 99,
  loadAverage1m: 0,
  memoryAvailableRatio: 0.9,
};

/** Клиент-заглушка: отдаёт заранее заданные дельты и результат. */
function fakeClient(deltas: StreamDelta[], result: CompletionResult): StreamingChatClient {
  return {
    async streamWithUsage(
      _messages: ChatMessage[],
      _options: CompleteOptions,
      onDelta: (delta: StreamDelta) => void,
    ): Promise<CompletionResult> {
      deltas.forEach(onDelta);
      return result;
    },
  };
}

/** Собирает сервис на управляемых часах и заглушках. */
function buildService(client: StreamingChatClient, overrides: Partial<GatewayConfig> = {}) {
  const config = { ...loadGatewayConfig({}), ...overrides };
  let currentTimeMs = 0;
  return new ChatService({
    config,
    queue: new RequestQueue(config.maxQueueDepth),
    readMetrics: () => IDLE_METRICS,
    createClient: () => client,
    now: () => {
      currentTimeMs += 5000;
      return currentTimeMs;
    },
  });
}

/** Собирает всё, что сервис сообщил по ходу обслуживания. */
function recordingHandlers() {
  const queued: number[] = [];
  const moods: string[] = [];
  const chunks: string[] = [];
  return {
    queued,
    moods,
    chunks,
    handlers: {
      onQueued: (waitingAhead: number) => queued.push(waitingAhead),
      onMood: (mood: { key: string }) => moods.push(mood.key),
      onDelta: (text: string) => chunks.push(text),
    },
  };
}

test('слишком длинный запрос отклоняется до постановки в очередь', async () => {
  const service = buildService(fakeClient([], { content: '' }), { maxPromptTokens: 1 });
  const { handlers, queued } = recordingHandlers();
  await assert.rejects(
    () =>
      service.respond(
        PERSONA,
        'очень длинный запрос, который точно длиннее одного токена',
        handlers,
      ),
    PromptTooLargeError,
  );
  assert.deepEqual(queued, []);
});

test('ответ стримится, настроение и позиция сообщаются, usage даёт число токенов', async () => {
  const client = fakeClient(
    [{ content: 'Ну ' }, { reasoning: 'размышляю' }, { content: 'ладно.' }],
    { content: 'Ну ладно.', usage: { prompt_tokens: 10, completion_tokens: 60, total_tokens: 70 } },
  );
  const service = buildService(client);
  const { handlers, queued, moods, chunks } = recordingHandlers();

  const outcome = await service.respond(PERSONA, 'Привет', handlers);

  assert.deepEqual(queued, [0]);
  assert.deepEqual(moods, ['calm']);
  assert.deepEqual(chunks, ['Ну ', 'ладно.']);
  assert.equal(outcome.content, 'Ну ладно.');
  assert.equal(outcome.cost.generatedTokens, 60);
  // Часы шагают по 5 с: старт 5, дельты 10 и 15, финиш 20.
  assert.equal(outcome.cost.wallSeconds, 15);
  assert.equal(outcome.cost.timeToFirstTokenSeconds, 5);
  assert.equal(outcome.cost.tokensPerSecond, 12);
  assert.equal(outcome.cost.cpuSeconds, 45);
});

test('ответ без единого текстового токена не ломает подсчёт времени', async () => {
  const client = fakeClient([{ reasoning: 'только мысли' }], { content: '' });
  const service = buildService(client);
  const { handlers, chunks } = recordingHandlers();
  const outcome = await service.respond(PERSONA, 'Привет', handlers);
  assert.deepEqual(chunks, []);
  assert.equal(outcome.cost.tokensPerSecond, 0);
  assert.equal(outcome.cost.timeToFirstTokenSeconds, outcome.cost.wallSeconds);
});

test('без usage число токенов оценивается по длине ответа', async () => {
  const client = fakeClient([{ content: 'Коротко' }], { content: 'Коротко' });
  const service = buildService(client);
  const { handlers } = recordingHandlers();
  const outcome = await service.respond(PERSONA, 'Привет', handlers);
  assert.ok(outcome.cost.generatedTokens > 0);
});

test('createUpstreamConfig подставляет модель персоны и адрес Ollama', () => {
  const config = loadGatewayConfig({});
  const upstream = createUpstreamConfig(config, 'qwen2.5:3b');
  assert.equal(upstream.model, 'qwen2.5:3b');
  assert.equal(upstream.baseUrl, config.upstreamBaseUrl);
  assert.equal(upstream.apiKey, 'ollama');
});
