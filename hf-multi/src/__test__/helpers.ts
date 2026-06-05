import type { TestContext } from 'node:test';
import { Writable } from 'node:stream';
import { ChatCompletionClient } from '../../../core/src/index.ts';
import { makeConfig } from '../../../core/src/__test__/helpers.ts';
import type { ClientFactory } from '../generate.ts';

export { makeConfig };

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

/** Фабрика клиентов, у которых complete вызывает impl(modelId). */
export function makeFactory(
  t: TestContext,
  impl: (modelId: string) => Promise<string>,
): ClientFactory {
  return (modelId: string) => {
    const client = new ChatCompletionClient(makeConfig());
    t.mock.method(client, 'complete', async () => impl(modelId));
    return client;
  };
}
