import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { requestJson } from '../index.ts';
import type { FetchLike, HttpResponse, RequestOptions } from '../index.ts';

/** Ответ-заглушка. */
function response(status: number, body: unknown, ok = status >= 200 && status < 300): HttpResponse {
  return {
    ok,
    status,
    statusText: `S${status}`,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

/** Базовые опции с мгновенной паузой и заданным fetch. */
function options(fetchFn: FetchLike, overrides: Partial<RequestOptions> = {}): RequestOptions {
  return {
    fetchFn,
    method: 'GET',
    url: 'https://api/x',
    headers: { Authorization: 'Bearer t' },
    timeoutMs: 1000,
    maxRetries: 3,
    retryBaseMs: 1,
    sleep: async () => {},
    ...overrides,
  };
}

describe('requestJson', () => {
  it('успех — возвращает JSON; тело сериализуется', async () => {
    let seenBody: string | undefined;
    const fetchFn: FetchLike = async (_url, init) => {
      seenBody = init.body;
      return response(200, { ok: true });
    };
    const result = await requestJson(options(fetchFn, { method: 'POST', body: { a: 1 } }));
    assert.deepEqual(result, { ok: true });
    assert.equal(seenBody, '{"a":1}');
  });

  it('204 No Content — null без разбора тела', async () => {
    const fetchFn: FetchLike = async () => ({
      ok: true,
      status: 204,
      statusText: 'No Content',
      json: async () => {
        throw new Error('тела нет');
      },
      text: async () => '',
    });
    assert.equal(await requestJson(options(fetchFn)), null);
  });

  it('429 → повтор до успеха', async () => {
    let calls = 0;
    const fetchFn: FetchLike = async () => {
      calls++;
      return calls < 3 ? response(429, 'rate', false) : response(200, { done: true });
    };
    assert.deepEqual(await requestJson(options(fetchFn)), { done: true });
    assert.equal(calls, 3);
  });

  it('5xx после исчерпания попыток — ошибка с телом', async () => {
    const fetchFn: FetchLike = async () => response(503, 'перегрузка', false);
    await assert.rejects(requestJson(options(fetchFn, { maxRetries: 1 })), /503.*перегрузка/s);
  });

  it('4xx (не ретраибельный) — сразу ошибка, без повторов', async () => {
    let calls = 0;
    const fetchFn: FetchLike = async () => {
      calls++;
      return response(422, 'unprocessable', false);
    };
    await assert.rejects(requestJson(options(fetchFn)), /422/);
    assert.equal(calls, 1);
  });

  it('тело ошибки нечитаемо — ошибка всё равно бросается', async () => {
    const fetchFn: FetchLike = async () => ({
      ok: false,
      status: 400,
      statusText: 'Bad',
      json: async () => ({}),
      text: async () => {
        throw new Error('поток оборван');
      },
    });
    await assert.rejects(requestJson(options(fetchFn)), /400 Bad/);
  });

  it('сетевой сбой → повтор, затем проброс после исчерпания', async () => {
    let calls = 0;
    const flaky: FetchLike = async () => {
      calls++;
      if (calls < 2) {
        throw new Error('ECONNRESET');
      }
      return response(200, { ok: 1 });
    };
    assert.deepEqual(await requestJson(options(flaky)), { ok: 1 });

    const alwaysDown: FetchLike = async () => {
      throw new Error('сеть недоступна');
    };
    await assert.rejects(requestJson(options(alwaysDown, { maxRetries: 2 })), /сеть недоступна/);
  });
});
