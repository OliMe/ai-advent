import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { ChatCompletionClient } from '../chat-completion-client.ts';
import type { CompletionResult } from '../chat-completion-client.ts';
import { makeConfig, completionResponse, streamResponse } from './helpers.ts';

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

  it('добавляет ограничения в тело запроса, когда они заданы', async t => {
    let capturedInit: RequestInit | undefined;
    const client = clientWithFetch(t, async (_url, init) => {
      capturedInit = init;
      return completionResponse('ок');
    });

    await client.complete([{ role: 'user', content: 'hi' }], {
      maxTokens: 128,
      stop: ['###', 'END'],
      responseFormat: { type: 'json_object' },
    });

    const body = JSON.parse(String(capturedInit?.body));
    assert.equal(body.max_tokens, 128);
    assert.deepEqual(body.stop, ['###', 'END']);
    assert.deepEqual(body.response_format, { type: 'json_object' });
  });

  it('нормализует одиночную стоп-строку в массив', async t => {
    let capturedInit: RequestInit | undefined;
    const client = clientWithFetch(t, async (_url, init) => {
      capturedInit = init;
      return completionResponse('ок');
    });

    await client.complete([{ role: 'user', content: 'hi' }], { stop: '###' });

    const body = JSON.parse(String(capturedInit?.body));
    assert.deepEqual(body.stop, ['###']);
  });

  it('отключает рассуждения при disableThinking', async t => {
    let capturedInit: RequestInit | undefined;
    const client = clientWithFetch(t, async (_url, init) => {
      capturedInit = init;
      return completionResponse('ок');
    });

    await client.complete([{ role: 'user', content: 'hi' }], { disableThinking: true });

    const body = JSON.parse(String(capturedInit?.body));
    assert.deepEqual(body.thinking, { type: 'disabled' });
  });

  it('completeWithUsage возвращает текст и статистику токенов', async t => {
    const client = clientWithFetch(
      t,
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ index: 0, message: { role: 'assistant', content: 'ок' } }],
            usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
          }),
          { status: 200 },
        ),
    );

    const result = await client.completeWithUsage([{ role: 'user', content: 'hi' }], {});

    assert.equal(result.content, 'ок');
    assert.deepEqual(result.usage, { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 });
  });

  it('переопределяет температуру из опций', async t => {
    let capturedInit: RequestInit | undefined;
    const client = clientWithFetch(t, async (_url, init) => {
      capturedInit = init;
      return completionResponse('ок');
    });

    await client.complete([{ role: 'user', content: 'hi' }], { temperature: 0.2 });

    const body = JSON.parse(String(capturedInit?.body));
    assert.equal(body.temperature, 0.2);
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

  it('подсказывает увеличить лимит, если ответ обрезан по длине', async t => {
    const body = { choices: [{ message: { content: '' }, finish_reason: 'length' }] };
    const client = clientWithFetch(
      t,
      async () => new Response(JSON.stringify(body), { status: 200 }),
    );

    await assert.rejects(client.complete([], { maxTokens: 5 }), /обрезан по лимиту max_tokens/);
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

/** Клиент с включёнными повторами и мгновенным бэкоффом (retryBaseMs: 1). */
function retryingClient(t: TestContext, stub: FetchStub, maxRetries = 2): ChatCompletionClient {
  t.mock.method(globalThis, 'fetch', stub as unknown as typeof fetch);
  return new ChatCompletionClient(makeConfig({ maxRetries, retryBaseMs: 1 }));
}

/** Заглушка: на первом вызове отдаёт `first`, далее — успешный ответ. */
function failThenSucceed(first: () => Response): { stub: FetchStub; calls: () => number } {
  let calls = 0;
  const stub: FetchStub = async () => {
    calls++;
    return calls === 1 ? first() : completionResponse('готово');
  };
  return { stub, calls: () => calls };
}

describe('ChatCompletionClient.complete — повторы', () => {
  it('повторяет при 429 и затем возвращает результат', async t => {
    const { stub, calls } = failThenSucceed(
      () => new Response('{}', { status: 429, statusText: 'Too Many Requests' }),
    );
    const client = retryingClient(t, stub);

    assert.equal(await client.complete([], {}), 'готово');
    assert.equal(calls(), 2);
  });

  it('повторяет при 5xx', async t => {
    const { stub, calls } = failThenSucceed(
      () => new Response('{}', { status: 503, statusText: 'Service Unavailable' }),
    );
    const client = retryingClient(t, stub);

    assert.equal(await client.complete([], {}), 'готово');
    assert.equal(calls(), 2);
  });

  it('повторяет при сетевом сбое', async t => {
    let calls = 0;
    const client = retryingClient(t, async () => {
      calls++;
      if (calls === 1) throw new Error('сеть');
      return completionResponse('готово');
    });

    assert.equal(await client.complete([], {}), 'готово');
    assert.equal(calls, 2);
  });

  it('учитывает заголовок Retry-After', async t => {
    const { stub } = failThenSucceed(
      () => new Response('{}', { status: 429, headers: { 'retry-after': '0' } }),
    );
    const client = retryingClient(t, stub);

    assert.equal(await client.complete([], {}), 'готово');
  });

  it('игнорирует нечисловой Retry-After и использует бэкофф', async t => {
    const { stub } = failThenSucceed(
      () => new Response('{}', { status: 429, headers: { 'retry-after': 'скоро' } }),
    );
    const client = retryingClient(t, stub);

    assert.equal(await client.complete([], {}), 'готово');
  });

  it('бросает ошибку, исчерпав повторы', async t => {
    let calls = 0;
    const client = retryingClient(
      t,
      async () => {
        calls++;
        return new Response('{}', { status: 429, statusText: 'Too Many Requests' });
      },
      1,
    );

    await assert.rejects(client.complete([], {}), /429/);
    assert.equal(calls, 2); // 1 попытка + 1 повтор
  });
});

describe('ChatCompletionClient.streamWithUsage', () => {
  /** Прогоняет стрим из заданных SSE-кусков, собирая дельты content и reasoning. */
  async function runStream(
    t: TestContext,
    chunks: string[],
  ): Promise<{ result: CompletionResult; contentDeltas: string[]; reasoningDeltas: string[] }> {
    const client = clientWithFetch(t, async () => streamResponse(chunks));
    const contentDeltas: string[] = [];
    const reasoningDeltas: string[] = [];
    const result = await client.streamWithUsage([{ role: 'user', content: 'hi' }], {}, delta => {
      if (delta.content !== undefined) contentDeltas.push(delta.content);
      if (delta.reasoning !== undefined) reasoningDeltas.push(delta.reasoning);
    });
    return { result, contentDeltas, reasoningDeltas };
  }

  it('собирает дельты content, отдаёт полный текст и usage', async t => {
    const { result, contentDeltas } = await runStream(t, [
      'data: {"choices":[{"delta":{"content":"При"}}]}\n',
      'data: {"choices":[{"delta":{"content":"вет"}}]}\n',
      'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n',
      'data: [DONE]\n',
    ]);

    assert.equal(result.content, 'Привет');
    assert.deepEqual(result.usage, { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
    assert.deepEqual(contentDeltas, ['При', 'вет']);
  });

  it('отдаёт reasoning_content отдельной дельтой', async t => {
    const { result, contentDeltas, reasoningDeltas } = await runStream(t, [
      'data: {"choices":[{"delta":{"reasoning_content":"дум"}}]}\n',
      'data: {"choices":[{"delta":{"content":"Ответ"}}]}\n',
      'data: [DONE]\n',
    ]);

    assert.equal(result.content, 'Ответ');
    assert.deepEqual(reasoningDeltas, ['дум']);
    assert.deepEqual(contentDeltas, ['Ответ']);
  });

  it('шлёт stream:true и stream_options.include_usage', async t => {
    let capturedInit: RequestInit | undefined;
    const client = clientWithFetch(t, async (_url, init) => {
      capturedInit = init;
      return streamResponse(['data: {"choices":[{"delta":{"content":"x"}}]}\n', 'data: [DONE]\n']);
    });

    await client.streamWithUsage([{ role: 'user', content: 'hi' }], {}, () => {});

    const body = JSON.parse(String(capturedInit?.body));
    assert.equal(body.stream, true);
    assert.deepEqual(body.stream_options, { include_usage: true });
  });

  it('склеивает SSE-строку, разорванную между чтениями', async t => {
    const { result } = await runStream(t, [
      'data: {"choices":[{"delta":{"con',
      'tent":"X"}}]}\n',
      'data: [DONE]\n',
    ]);

    assert.equal(result.content, 'X');
  });

  it('пропускает не-data и пустые строки', async t => {
    const { result } = await runStream(t, [
      ': keep-alive\n',
      '\n',
      'data: {"choices":[{"delta":{"content":"Y"}}]}\n',
      'data: [DONE]\n',
    ]);

    assert.equal(result.content, 'Y');
  });

  it('завершается по концу тела без [DONE]', async t => {
    const { result } = await runStream(t, ['data: {"choices":[{"delta":{"content":"Z"}}]}\n']);

    assert.equal(result.content, 'Z');
  });

  it('бросает «обрезан по лимиту» при пустом content и finish_reason length', async t => {
    await assert.rejects(
      runStream(t, [
        'data: {"choices":[{"delta":{"content":""},"finish_reason":"length"}]}\n',
        'data: [DONE]\n',
      ]),
      /обрезан по лимиту/,
    );
  });

  it('бросает «пустой ответ» при потоке без текста', async t => {
    await assert.rejects(runStream(t, ['data: [DONE]\n']), /пустой ответ/);
  });

  it('бросает «пустой ответ» при отсутствии тела', async t => {
    const client = clientWithFetch(t, async () => new Response(null, { status: 200 }));

    await assert.rejects(
      client.streamWithUsage([{ role: 'user', content: 'hi' }], {}, () => {}),
      /пустой ответ/,
    );
  });

  /**
   * Заглушка fetch, отдающая SSE-чанки с паузами и честно реагирующая на signal:
   * при abort поток тела падает с reason — как настоящий fetch.
   */
  function delayedStreamStub(chunks: string[], delaysMs: number[]): FetchStub {
    return async (_url, init) => {
      const encoder = new TextEncoder();
      let index = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (index >= chunks.length) {
            controller.close();
            return;
          }
          try {
            await new Promise<void>((resolve, reject) => {
              const onAbort = () => {
                clearTimeout(timer);
                reject(init.signal?.reason);
              };
              const timer = setTimeout(() => {
                init.signal?.removeEventListener('abort', onAbort);
                resolve();
              }, delaysMs[index]);
              init.signal?.addEventListener('abort', onAbort, { once: true });
            });
          } catch (reason) {
            controller.error(reason);
            return;
          }
          controller.enqueue(encoder.encode(chunks[index]));
          index++;
        },
      });
      return new Response(body, { status: 200 });
    };
  }

  it('обрывает по простою (TimeoutError), если данные перестали приходить', async t => {
    // Первый чанк быстрый, второй «зависает» дольше idle-таймаута.
    const client = clientWithFetch(
      t,
      delayedStreamStub(
        ['data: {"choices":[{"delta":{"content":"При"}}]}\n', 'data: [DONE]\n'],
        [0, 200],
      ),
    );

    await assert.rejects(
      client.streamWithUsage([{ role: 'user', content: 'hi' }], { idleTimeoutMs: 20 }, () => {}),
      (error: Error) => error.name === 'TimeoutError',
    );
  });

  it('не обрывает «живой» поток: таймаут на простой, а не на общую длительность', async t => {
    // Каждая пауза (10мс) меньше idle-таймаута (60мс), хотя суммарно их больше.
    const client = clientWithFetch(
      t,
      delayedStreamStub(
        [
          'data: {"choices":[{"delta":{"content":"a"}}]}\n',
          'data: {"choices":[{"delta":{"content":"b"}}]}\n',
          'data: {"choices":[{"delta":{"content":"c"}}]}\n',
          'data: [DONE]\n',
        ],
        [10, 10, 10, 10],
      ),
    );

    // Передаём ещё и пользовательский signal — покрывает ветку AbortSignal.any.
    const userSignal = new AbortController().signal;
    const result = await client.streamWithUsage(
      [{ role: 'user', content: 'hi' }],
      { idleTimeoutMs: 60, signal: userSignal },
      () => {},
    );

    assert.equal(result.content, 'abc');
  });
});
