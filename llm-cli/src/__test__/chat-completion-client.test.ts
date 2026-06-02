import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { ChatCompletionClient } from '../chat-completion-client.ts';
import { makeConfig, completionResponse } from './helpers.ts';

/** Реализация-заглушка fetch: получает URL и init, возвращает Response. */
type FetchStub = (url: string, init: RequestInit) => Promise<Response>;

/** Создаёт клиент и подменяет глобальный fetch заданной заглушкой. */
function clientWithFetch(t: TestContext, stub: FetchStub): ChatCompletionClient {
  t.mock.method(globalThis, 'fetch', stub as unknown as typeof fetch);
  return new ChatCompletionClient(makeConfig());
}

describe('ChatCompletionClient.complete', () => {
  it('возвращает текст ответа и шлёт корректный запрос', async t => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const client = clientWithFetch(t, async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return completionResponse('Привет!');
    });

    const signal = AbortSignal.timeout(1000);
    const answer = await client.complete([{ role: 'user', content: 'hi' }], { signal });

    assert.equal(answer, 'Привет!');
    assert.equal(capturedUrl, 'https://example.test/v1/chat/completions');
    assert.equal(capturedInit?.method, 'POST');
    const headers = capturedInit?.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer test-key');
    assert.equal(headers['Content-Type'], 'application/json');
    assert.equal(capturedInit?.signal, signal);
    const body = JSON.parse(String(capturedInit?.body));
    assert.equal(body.model, 'test-model');
    assert.equal(body.temperature, 0.7);
    assert.equal(body.stream, false);
    assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }]);
  });

  it('бросает ошибку со статусом и сообщением из тела при !ok', async t => {
    const client = clientWithFetch(
      t,
      async () =>
        new Response(JSON.stringify({ error: { message: 'неверный ключ' } }), {
          status: 401,
          statusText: 'Unauthorized',
        }),
    );

    await assert.rejects(client.complete([], {}), /401 Unauthorized: неверный ключ/);
  });

  it('подставляет «неизвестная ошибка», если в теле нет error.message', async t => {
    const client = clientWithFetch(
      t,
      async () => new Response(JSON.stringify({}), { status: 500, statusText: 'Error' }),
    );

    await assert.rejects(client.complete([], {}), /неизвестная ошибка/);
  });

  it('сообщает о неразборном теле ошибки', async t => {
    const client = clientWithFetch(
      t,
      async () => new Response('<<не json>>', { status: 500, statusText: 'Error' }),
    );

    await assert.rejects(client.complete([], {}), /не удалось разобрать тело ответа/);
  });

  it('бросает ошибку при пустом ответе без текста', async t => {
    // Каждый вариант обрывает цепочку choices?.[0]?.message?.content в своём звене.
    const emptyBodies = [
      {},
      { choices: [] },
      { choices: [{}] },
      { choices: [{ message: {} }] },
      { choices: [{ message: { content: '' } }] },
    ];

    for (const body of emptyBodies) {
      const client = clientWithFetch(
        t,
        async () => new Response(JSON.stringify(body), { status: 200 }),
      );
      await assert.rejects(client.complete([], {}), /пустой ответ/);
    }
  });

  it('оборачивает сетевую ошибку (Error)', async t => {
    const client = clientWithFetch(t, async () => {
      throw new Error('сеть недоступна');
    });

    await assert.rejects(
      client.complete([], {}),
      /Не удалось выполнить запрос к API.*сеть недоступна/s,
    );
  });

  it('оборачивает не-Error причину через String()', async t => {
    const client = clientWithFetch(t, async () => {
      throw 'строковый сбой';
    });

    await assert.rejects(
      client.complete([], {}),
      /Не удалось выполнить запрос к API.*строковый сбой/s,
    );
  });

  it('пробрасывает TimeoutError как есть', async t => {
    const timeoutError = new Error('timeout');
    timeoutError.name = 'TimeoutError';
    const client = clientWithFetch(t, async () => {
      throw timeoutError;
    });

    await assert.rejects(client.complete([], {}), (error: Error) => {
      assert.equal(error.name, 'TimeoutError');
      assert.equal(error.message, 'timeout');
      return true;
    });
  });

  it('пробрасывает AbortError как есть', async t => {
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    const client = clientWithFetch(t, async () => {
      throw abortError;
    });

    await assert.rejects(client.complete([], {}), (error: Error) => {
      assert.equal(error.name, 'AbortError');
      return true;
    });
  });
});
