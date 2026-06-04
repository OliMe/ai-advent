import type { TestContext } from 'node:test';
import { Writable } from 'node:stream';
import { ChatCompletionClient } from '../../../core/src/index.ts';
import { makeConfig } from '../../../core/src/__test__/helpers.ts';

export { makeConfig };

/** Клиент с подменённым методом complete. */
export function makeClient(
  t: TestContext,
  complete: ChatCompletionClient['complete'],
): ChatCompletionClient {
  const client = new ChatCompletionClient(makeConfig());
  t.mock.method(client, 'complete', complete);
  return client;
}

/** Поток-приёмник: накапливает записанный текст. */
export function makeCollector(): { stream: Writable; text: () => string } {
  let buffer = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      buffer += chunk.toString();
      callback();
    },
  });
  return { stream, text: () => buffer };
}
