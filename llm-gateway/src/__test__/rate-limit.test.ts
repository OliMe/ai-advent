import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TokenBucketRateLimiter } from '../rate-limit.ts';

/** Управляемые часы: тесты не должны зависеть от реального времени. */
function fixedClock(startMs: number) {
  let current = startMs;
  return {
    now: () => current,
    advance: (deltaMs: number) => {
      current += deltaMs;
    },
  };
}

test('первый запрос пропускается, остаток уменьшается', () => {
  const clock = fixedClock(0);
  const limiter = new TokenBucketRateLimiter(3, 60, clock.now);
  const decision = limiter.consume('клиент');
  assert.equal(decision.allowed, true);
  assert.equal(decision.remaining, 2);
  assert.equal(decision.retryAfterSeconds, 0);
});

test('ведро исчерпывается — запрос отклоняется с временем ожидания', () => {
  const clock = fixedClock(0);
  const limiter = new TokenBucketRateLimiter(2, 60, clock.now);
  limiter.consume('клиент');
  limiter.consume('клиент');
  const decision = limiter.consume('клиент');
  assert.equal(decision.allowed, false);
  assert.equal(decision.remaining, 0);
  assert.equal(decision.retryAfterSeconds, 1);
});

test('ведро пополняется со временем', () => {
  const clock = fixedClock(0);
  const limiter = new TokenBucketRateLimiter(2, 60, clock.now);
  limiter.consume('клиент');
  limiter.consume('клиент');
  assert.equal(limiter.consume('клиент').allowed, false);
  clock.advance(1000);
  assert.equal(limiter.consume('клиент').allowed, true);
});

test('пополнение не превышает ёмкости ведра', () => {
  const clock = fixedClock(0);
  const limiter = new TokenBucketRateLimiter(2, 600, clock.now);
  limiter.consume('клиент');
  clock.advance(60_000);
  const decision = limiter.consume('клиент');
  assert.equal(decision.allowed, true);
  assert.equal(decision.remaining, 1);
});

test('клиенты считаются раздельно', () => {
  const clock = fixedClock(0);
  const limiter = new TokenBucketRateLimiter(1, 60, clock.now);
  assert.equal(limiter.consume('первый').allowed, true);
  assert.equal(limiter.consume('второй').allowed, true);
  assert.equal(limiter.consume('первый').allowed, false);
});

test('часы по умолчанию — системные', () => {
  const limiter = new TokenBucketRateLimiter(1, 60);
  assert.equal(limiter.consume('клиент').allowed, true);
});
