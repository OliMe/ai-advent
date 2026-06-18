import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { askModel, runOnce, createSpinner, streamAnswer, augmentSystemPrompt } from '../index.ts';
import { clientWith, clientWithStream, makeCollector } from './helpers.ts';
import { ChatCompletionClient } from '../../../core/src/index.ts';
import {
  makeConfig,
  completionResponse,
  streamResponse,
} from '../../../core/src/__test__/helpers.ts';
import type {
  ChatMessage,
  CompleteOptions,
  CompletionResult,
  GenerationLimits,
  StreamDelta,
  Usage,
} from '../../../core/src/index.ts';

describe('askModel', () => {
  it('передаёт клиенту AbortSignal, ограничения и disableThinking, возвращает ответ+usage', async t => {
    let capturedOptions: CompleteOptions | undefined;
    const client = clientWith(t, async (_messages, options) => {
      capturedOptions = options;
      return { content: 'ответ', usage: undefined };
    });

    const result = await askModel(
      client,
      [{ role: 'user', content: 'x' }],
      5000,
      { maxTokens: 50, stop: ['END'], responseFormat: { type: 'json_object' } },
      true,
      0.3,
    );

    assert.equal(result.content, 'ответ');
    assert.ok(capturedOptions?.signal instanceof AbortSignal);
    assert.equal(capturedOptions?.maxTokens, 50);
    assert.deepEqual(capturedOptions?.stop, ['END']);
    assert.deepEqual(capturedOptions?.responseFormat, { type: 'json_object' });
    assert.equal(capturedOptions?.disableThinking, true);
    assert.equal(capturedOptions?.temperature, 0.3);
  });
});

describe('runOnce', () => {
  it('без стрима пишет ответ модели и шлёт system+user', async t => {
    const calls: unknown[] = [];
    const client = clientWith(t, async messages => {
      calls.push(messages);
      return { content: 'единственный ответ', usage: undefined };
    });
    const output = makeCollector();

    await runOnce(client, makeConfig(), 'привет', {}, false, 0.7, false, output.stream);

    assert.equal(output.text(), 'единственный ответ\n');
    assert.deepEqual(calls[0], [
      { role: 'system', content: 'Ты — ассистент.' },
      { role: 'user', content: 'привет' },
    ]);
  });

  it('со стримом печатает ответ и завершает переводом строки', async t => {
    const client = clientWithStream(t, () => 'потоковый ответ');
    const output = makeCollector();

    await runOnce(client, makeConfig(), 'привет', {}, false, 0.7, true, output.stream);

    assert.equal(output.text(), 'потоковый ответ\n');
  });
});

describe('createSpinner', () => {
  /** Поток-приёмник с пометкой TTY. */
  function makeTtyCollector(): { stream: Writable & { isTTY?: boolean }; text: () => string } {
    const collector = makeCollector();
    const stream = collector.stream as Writable & { isTTY?: boolean };
    stream.isTTY = true;
    return { stream, text: collector.text };
  }

  it('на TTY анимируется и очищает строку при остановке (повторный stop — no-op)', t => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const out = makeTtyCollector();

    const spinner = createSpinner(out.stream, 'думает…');
    t.mock.timers.tick(100); // первый кадр
    t.mock.timers.tick(100); // второй кадр
    spinner.stop();
    spinner.stop(); // повторный вызов ничего не делает

    assert.match(out.text(), /думает…/);
    assert.match(out.text(), /\[K/); // строка спиннера очищена
  });

  it('без TTY ничего не пишет', () => {
    const out = makeCollector();

    const spinner = createSpinner(out.stream, 'думает…');
    spinner.stop();

    assert.equal(out.text(), '');
  });
});

describe('streamAnswer', () => {
  /** Клиент, чей streamWithUsage отдаёт заданные дельты и итог. */
  function streamingClient(t: TestContext, deltas: StreamDelta[], content: string) {
    const client = new ChatCompletionClient(makeConfig());
    t.mock.method(
      client,
      'streamWithUsage',
      async (
        _messages: ChatMessage[],
        _options: CompleteOptions,
        onDelta: (delta: StreamDelta) => void,
      ) => {
        for (const delta of deltas) onDelta(delta);
        return { content, usage: undefined };
      },
    );
    return client;
  }

  it('печатает content, зовёт onFirstContent один раз, игнорирует reasoning', async t => {
    const client = streamingClient(
      t,
      [{ reasoning: 'дум' }, { content: 'При' }, { content: 'вет' }],
      'Привет',
    );
    const out = makeCollector();
    let firstContentCalls = 0;

    const result = await streamAnswer(
      client,
      [{ role: 'user', content: 'x' }],
      5000,
      {},
      false,
      0.7,
      out.stream,
      () => {
        firstContentCalls++;
        out.stream.write('PFX:');
      },
    );

    assert.equal(result.content, 'Привет');
    assert.equal(firstContentCalls, 1); // префикс печатается ровно на первом видимом токене
    assert.equal(out.text(), 'PFX:Привет'); // reasoning не печатается
  });

  it('работает без onFirstContent', async t => {
    const client = streamingClient(t, [{ content: 'A' }], 'A');
    const out = makeCollector();

    const result = await streamAnswer(
      client,
      [{ role: 'user', content: 'x' }],
      5000,
      {},
      false,
      0.7,
      out.stream,
    );

    assert.equal(result.content, 'A');
    assert.equal(out.text(), 'A');
  });

  it('передаёт idleTimeoutMs (таймаут по простою), а не total-signal', async t => {
    let captured: CompleteOptions | undefined;
    const client = new ChatCompletionClient(makeConfig());
    t.mock.method(
      client,
      'streamWithUsage',
      async (
        _messages: ChatMessage[],
        options: CompleteOptions,
        onDelta: (delta: StreamDelta) => void,
      ) => {
        captured = options;
        onDelta({ content: 'A' });
        return { content: 'A', usage: undefined };
      },
    );
    const out = makeCollector();

    await streamAnswer(client, [{ role: 'user', content: 'x' }], 12345, {}, false, 0.7, out.stream);

    assert.equal(captured?.idleTimeoutMs, 12345); // таймаут по простою = requestTimeoutMs
    assert.equal(captured?.signal, undefined); // total-таймаут не навешиваем
  });
});

describe('augmentSystemPrompt', () => {
  it('дописывает схему в промпт при json_schema', () => {
    const schema = { type: 'object', properties: { city: { type: 'string' } } };
    const result = augmentSystemPrompt('Базовый промпт.', {
      responseFormat: { type: 'json_schema', json_schema: { name: 'response', schema } },
    });

    assert.match(result, /^Базовый промпт\./);
    assert.match(result, /строго в виде JSON/);
    assert.match(result, /"city"/);
  });

  it('не меняет промпт при json_object', () => {
    const result = augmentSystemPrompt('Базовый промпт.', {
      responseFormat: { type: 'json_object' },
    });
    assert.equal(result, 'Базовый промпт.');
  });

  it('не меняет промпт без ограничения формата', () => {
    assert.equal(augmentSystemPrompt('Базовый промпт.', {}), 'Базовый промпт.');
  });
});
