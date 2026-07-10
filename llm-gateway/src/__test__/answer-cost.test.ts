import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeAnswerCost, formatAnswerCost } from '../answer-cost.ts';

test('CPU-секунды считаются по полному времени × выданные ядра', () => {
  const cost = describeAnswerCost(
    {
      wallMilliseconds: 14_000,
      timeToFirstTokenMilliseconds: 4000,
      generationMilliseconds: 10_000,
    },
    3,
    150,
  );
  assert.equal(cost.wallSeconds, 14);
  assert.equal(cost.cpuSeconds, 42);
  assert.equal(cost.timeToFirstTokenSeconds, 4);
  assert.equal(cost.generatedTokens, 150);
});

test('скорость генерации не учитывает подгрузку модели и обработку промпта', () => {
  const cost = describeAnswerCost(
    {
      wallMilliseconds: 14_000,
      timeToFirstTokenMilliseconds: 4000,
      generationMilliseconds: 10_000,
    },
    3,
    150,
  );
  // 150 токенов за 10 секунд окна генерации, а не за 14 секунд обслуживания.
  assert.equal(cost.tokensPerSecond, 15);
});

test('ответ без единого токена не даёт деления на ноль', () => {
  const cost = describeAnswerCost(
    { wallMilliseconds: 5000, timeToFirstTokenMilliseconds: 5000, generationMilliseconds: 0 },
    3,
    0,
  );
  assert.equal(cost.tokensPerSecond, 0);
});

test('подпись под ответом читается человеком', () => {
  const text = formatAnswerCost(
    describeAnswerCost(
      {
        wallMilliseconds: 14_000,
        timeToFirstTokenMilliseconds: 4000,
        generationMilliseconds: 10_000,
      },
      3,
      150,
    ),
  );
  assert.equal(
    text,
    '42.0 CPU-секунд · 4.0 с до первого токена · 150 токенов на 15.0 токенов/с · 14.0 с всего',
  );
});
