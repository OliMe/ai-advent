import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QueueOverflowError, RequestQueue } from '../request-queue.ts';

/** Обещание, разрешаемое снаружи — чтобы удерживать задачу в очереди. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('задачи исполняются строго по одной, в порядке постановки', async () => {
  const queue = new RequestQueue(4);
  const order: string[] = [];
  const first = deferred<void>();

  const firstRun = queue.run(async () => {
    order.push('первая начата');
    await first.promise;
    order.push('первая закончена');
  });
  const secondRun = queue.run(async () => {
    order.push('вторая начата');
  });

  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['первая начата']);

  first.resolve();
  await Promise.all([firstRun, secondRun]);
  assert.deepEqual(order, ['первая начата', 'первая закончена', 'вторая начата']);
});

test('позиция в очереди сообщается задаче', async () => {
  const queue = new RequestQueue(4);
  const gate = deferred<void>();
  const positions: number[] = [];

  const first = queue.run(async waitingAhead => {
    positions.push(waitingAhead);
    await gate.promise;
  });
  const second = queue.run(async waitingAhead => {
    positions.push(waitingAhead);
  });

  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(positions, [0, 1]);
});

test('глубина очереди растёт и падает', async () => {
  const queue = new RequestQueue(4);
  assert.equal(queue.depth, 0);
  const gate = deferred<void>();
  const run = queue.run(async () => {
    assert.equal(queue.depth, 1);
    await gate.promise;
  });
  gate.resolve();
  await run;
  assert.equal(queue.depth, 0);
});

test('переполнение очереди — отказ', async () => {
  const queue = new RequestQueue(1);
  const gate = deferred<void>();
  const running = queue.run(async () => {
    await gate.promise;
  });
  await assert.rejects(() => queue.run(async () => undefined), QueueOverflowError);
  gate.resolve();
  await running;
});

test('ошибка одной задачи не ломает следующие', async () => {
  const queue = new RequestQueue(4);
  const failing = queue.run(async () => {
    throw new Error('упала');
  });
  await assert.rejects(() => failing, /упала/);
  const result = await queue.run(async () => 'жива');
  assert.equal(result, 'жива');
});
