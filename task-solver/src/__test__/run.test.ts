import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as readline from 'node:readline/promises';
import { PassThrough } from 'node:stream';
import type { ChatCompletionClient } from '../../../core/src/index.ts';
import { runSolve } from '../run.ts';
import { makeClient, makeConfig } from './helpers.ts';

/**
 * Прогоняет интерактивный сценарий, подавая очередной ответ при появлении
 * приглашения «Задача:» или «Эксперты» (детерминированно — по одной строке на вопрос).
 */
function driveSolve(
  client: ChatCompletionClient,
  lines: string[],
): { finished: Promise<void>; text: () => string } {
  const input = new PassThrough();
  let buffer = '';
  let next = 0;
  const output = new PassThrough();
  output.on('data', chunk => {
    const text = chunk.toString();
    buffer += text;
    if ((text.includes('Задача:') || text.includes('Эксперты')) && next < lines.length) {
      const line = lines[next++];
      setImmediate(() => input.write(line + '\n'));
    }
  });
  const finished = runSolve(client, makeConfig(), input, output, readline.createInterface);
  return { finished, text: () => buffer };
}

describe('runSolve', () => {
  it('спрашивает задачу и экспертов, печатает 4 решения и оценку', async t => {
    let calls = 0;
    const client = makeClient(t, async () => {
      calls++;
      return `r${calls}`;
    });

    const { finished, text } = driveSolve(client, ['Посчитай 2+2', 'математик, физик']);
    await finished;

    assert.equal(calls, 6);
    assert.match(text(), /\[1\] Простой запрос/);
    assert.match(text(), /\[2\] Пошаговое решение/);
    assert.match(text(), /\[3\] Двухшаговый/);
    assert.match(text(), /\[4\] Панель экспертов/);
    assert.match(text(), /=== Оценка GLM ===\nr6/);
  });

  it('сообщает, если задача не указана, и не дёргает модель', async t => {
    let calls = 0;
    const client = makeClient(t, async () => {
      calls++;
      return 'не должно вызваться';
    });

    const { finished, text } = driveSolve(client, ['']);
    await finished;

    assert.equal(calls, 0);
    assert.match(text(), /Задача не указана/);
  });
});
