import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isRetryableStatus, retryDelayMs, sleep } from '../http-retry.ts';

describe('isRetryableStatus', () => {
  it('429 и 5xx — повторяемы; 4xx (кроме 429) и 2xx — нет', () => {
    assert.equal(isRetryableStatus(429), true);
    assert.equal(isRetryableStatus(500), true);
    assert.equal(isRetryableStatus(503), true);
    assert.equal(isRetryableStatus(400), false);
    assert.equal(isRetryableStatus(200), false);
  });
});

describe('retryDelayMs', () => {
  it('без ответа — экспонента base*2^attempt', () => {
    assert.equal(retryDelayMs(500, 0), 500);
    assert.equal(retryDelayMs(500, 2), 2000);
  });

  it('Retry-After с числом — секунды*1000', () => {
    const response = new Response(null, { headers: { 'retry-after': '2' } });
    assert.equal(retryDelayMs(500, 3, response), 2000);
  });

  it('Retry-After нечисловой — откат к экспоненте', () => {
    const response = new Response(null, { headers: { 'retry-after': 'soon' } });
    assert.equal(retryDelayMs(500, 1, response), 1000);
  });

  it('ответ без Retry-After — экспонента', () => {
    assert.equal(retryDelayMs(500, 0, new Response(null)), 500);
  });
});

describe('sleep', () => {
  it('резолвится после задержки', async () => {
    await sleep(1);
    assert.ok(true);
  });
});
