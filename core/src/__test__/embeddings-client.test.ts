import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EmbeddingsClient, loadEmbeddingsConfig } from '../index.ts';
import type { EmbeddingsConfig } from '../index.ts';

/** Конфиг эмбеддингов для тестов (быстрые повторы). */
function makeConfig(overrides: Partial<EmbeddingsConfig> = {}): EmbeddingsConfig {
  return {
    url: 'http://localhost:11434/v1/embeddings',
    model: 'nomic-embed-text',
    requestTimeoutMs: 5000,
    maxRetries: 1,
    retryBaseMs: 1,
    ...overrides,
  };
}

/** Заглушка fetch: получает URL и init, возвращает Response. */
type FetchStub = (url: string, init: RequestInit) => Promise<Response>;

function clientWithFetch(t: TestContext, stub: FetchStub, config = makeConfig()): EmbeddingsClient {
  t.mock.method(globalThis, 'fetch', stub as unknown as typeof fetch);
  return new EmbeddingsClient(config);
}

/** Успешный ответ /embeddings с заданными записями. */
function embeddingsResponse(data: { index: number; embedding: number[] }[]): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const env = (values: Record<string, string | undefined>): NodeJS.ProcessEnv =>
  values as NodeJS.ProcessEnv;

describe('loadEmbeddingsConfig', () => {
  it('url и модель есть → конфиг с дефолтами, без ключа Authorization', () => {
    const config = loadEmbeddingsConfig(
      env({ LLM_EMBEDDINGS_URL: ' http://x/embeddings ', LLM_EMBEDDINGS_MODEL: ' m ' }),
    );
    assert.equal(config.url, 'http://x/embeddings');
    assert.equal(config.model, 'm');
    assert.equal(config.apiKey, undefined);
    assert.equal(config.requestTimeoutMs, 60_000);
    assert.equal(config.maxRetries, 3);
    assert.equal(config.retryBaseMs, 500);
  });

  it('ключ и переопределения из окружения', () => {
    const config = loadEmbeddingsConfig(
      env({
        LLM_EMBEDDINGS_URL: 'http://x',
        LLM_EMBEDDINGS_MODEL: 'm',
        LLM_EMBEDDINGS_API_KEY: 'k',
        LLM_REQUEST_TIMEOUT_MS: '5000',
        LLM_MAX_RETRIES: '0',
        LLM_RETRY_BASE_MS: '100',
      }),
    );
    assert.equal(config.apiKey, 'k');
    assert.equal(config.requestTimeoutMs, 5000);
    assert.equal(config.maxRetries, 0);
    assert.equal(config.retryBaseMs, 100);
  });

  it('невалидный maxRetries → дефолт 3', () => {
    const config = loadEmbeddingsConfig(
      env({ LLM_EMBEDDINGS_URL: 'http://x', LLM_EMBEDDINGS_MODEL: 'm', LLM_MAX_RETRIES: 'abc' }),
    );
    assert.equal(config.maxRetries, 3);
  });

  it('нет URL → ошибка; нет модели → ошибка', () => {
    assert.throws(
      () => loadEmbeddingsConfig(env({ LLM_EMBEDDINGS_MODEL: 'm' })),
      /LLM_EMBEDDINGS_URL/,
    );
    assert.throws(
      () => loadEmbeddingsConfig(env({ LLM_EMBEDDINGS_URL: 'http://x' })),
      /LLM_EMBEDDINGS_MODEL/,
    );
  });
});

describe('EmbeddingsClient.embed', () => {
  it('пустой вход → пусто, без обращения к сети', async t => {
    let called = false;
    const client = clientWithFetch(t, async () => {
      called = true;
      return embeddingsResponse([]);
    });
    assert.deepEqual(await client.embed([]), []);
    assert.equal(called, false);
  });

  it('возвращает векторы в исходном порядке (сортировка по index); шлёт model+input и ключ', async t => {
    let capturedInit: RequestInit | undefined;
    const client = clientWithFetch(
      t,
      async (_url, init) => {
        capturedInit = init;
        return embeddingsResponse([
          { index: 1, embedding: [3, 4] },
          { index: 0, embedding: [1, 2] },
        ]);
      },
      makeConfig({ apiKey: 'secret' }),
    );
    const vectors = await client.embed(['a', 'b']);
    assert.deepEqual(vectors, [
      [1, 2],
      [3, 4],
    ]);
    const headers = capturedInit?.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer secret');
    assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
      model: 'nomic-embed-text',
      input: ['a', 'b'],
    });
  });

  it('ответ без поля data → пустой результат', async t => {
    const client = clientWithFetch(
      t,
      async () =>
        new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    assert.deepEqual(await client.embed(['a']), []);
  });

  it('без ключа — нет заголовка Authorization', async t => {
    let capturedInit: RequestInit | undefined;
    const client = clientWithFetch(t, async (_url, init) => {
      capturedInit = init;
      return embeddingsResponse([{ index: 0, embedding: [1] }]);
    });
    await client.embed(['a']);
    const headers = capturedInit?.headers as Record<string, string>;
    assert.equal(headers.Authorization, undefined);
  });

  it('повтор при 500, затем успех', async t => {
    let calls = 0;
    const client = clientWithFetch(t, async () => {
      calls++;
      return calls === 1
        ? new Response('oops', { status: 500 })
        : embeddingsResponse([{ index: 0, embedding: [1, 2] }]);
    });
    assert.deepEqual(await client.embed(['a']), [[1, 2]]);
    assert.equal(calls, 2);
  });

  it('неповторяемая ошибка (400) → бросает с сообщением из тела', async t => {
    const client = clientWithFetch(
      t,
      async () =>
        new Response(JSON.stringify({ error: { message: 'bad input' } }), { status: 400 }),
    );
    await assert.rejects(() => client.embed(['a']), /400.*bad input/s);
  });

  it('ошибка 400 с не-JSON телом → понятное сообщение', async t => {
    const client = clientWithFetch(t, async () => new Response('<<html>>', { status: 400 }));
    await assert.rejects(() => client.embed(['a']), /не удалось разобрать тело ответа/);
  });

  it('ошибка с JSON-телом без error.message → «неизвестная ошибка»', async t => {
    const client = clientWithFetch(t, async () => new Response('{}', { status: 400 }));
    await assert.rejects(() => client.embed(['a']), /неизвестная ошибка/);
  });

  it('5xx исчерпывает повторы → бросает', async t => {
    let calls = 0;
    const client = clientWithFetch(t, async () => {
      calls++;
      return new Response('busy', { status: 503 });
    });
    await assert.rejects(() => client.embed(['a']), /503/);
    assert.equal(calls, 2); // первый + один повтор (maxRetries=1)
  });

  it('сетевой сбой исчерпывает повторы → бросает', async t => {
    const client = clientWithFetch(t, async () => {
      throw new Error('ECONNREFUSED');
    });
    await assert.rejects(() => client.embed(['a']), /Не удалось выполнить запрос эмбеддингов/);
  });

  it('таймаут (TimeoutError) пробрасывается как есть', async t => {
    const client = clientWithFetch(t, async () => {
      const error = new Error('timed out');
      error.name = 'TimeoutError';
      throw error;
    });
    await assert.rejects(() => client.embed(['a']), /timed out/);
  });

  it('отмена (AbortError) пробрасывается как есть', async t => {
    const client = clientWithFetch(t, async () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    });
    await assert.rejects(() => client.embed(['a']), { name: 'AbortError' });
  });

  it('не-Error сетевой сбой приводится к строке в сообщении', async t => {
    const client = clientWithFetch(t, async () => {
      throw 'строковый сбой';
    });
    await assert.rejects(() => client.embed(['a']), /строковый сбой/);
  });
});
