import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Conversation } from '../index.ts';
import type { ConversationConfig } from '../index.ts';
import { ChatCompletionClient } from '../index.ts';
import type { ChatMessage, CompleteOptions, StreamDelta, Usage } from '../index.ts';
import { clientWith, makeConfig } from './helpers.ts';

const config: ConversationConfig = {
  systemPrompt: 'Ты — ассистент.',
  temperature: 0.5,
  contextTokens: 8192,
  requestTimeoutMs: 5000,
};

describe('Conversation', () => {
  it('создаётся с системным сообщением из конфига', () => {
    const conversation = new Conversation(new ChatCompletionClient(makeConfig()), config);
    assert.deepEqual(conversation.messages, [{ role: 'system', content: 'Ты — ассистент.' }]);
  });

  it('ask (не-стрим): шлёт опции, копит транскрипт и итоговый usage', async t => {
    let captured: { messages: ChatMessage[]; options: CompleteOptions } | undefined;
    const client = clientWith(t, async (messages, options) => {
      captured = { messages, options };
      return {
        content: 'ответ',
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      };
    });
    const conversation = new Conversation(client, config);

    const result = await conversation.ask('привет');

    assert.equal(result.content, 'ответ');
    assert.equal(captured?.options.temperature, 0.5);
    assert.ok(captured?.options.signal instanceof AbortSignal);
    assert.deepEqual(
      conversation.messages.map(m => m.role),
      ['system', 'user', 'assistant'],
    );
    assert.equal(conversation.messages.at(-1)?.content, 'ответ');
    assert.deepEqual(conversation.totals, {
      prompt_tokens: 3,
      completion_tokens: 2,
      total_tokens: 5,
    });
  });

  it('ask: вызывает onUsage с расходом токенов (учёт вложенных агентов)', async t => {
    const seen: Usage[] = [];
    const withUsage = clientWith(t, async () => ({
      content: 'ответ',
      usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
    }));
    await new Conversation(withUsage, { ...config, onUsage: u => seen.push(u) }).ask('привет');
    assert.deepEqual(seen, [{ prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 }]);

    // Без usage от провайдера onUsage не вызывается.
    const noUsage = clientWith(t, async () => ({ content: 'x', usage: undefined }));
    await new Conversation(noUsage, { ...config, onUsage: u => seen.push(u) }).ask('ещё');
    assert.equal(seen.length, 1);
  });

  it('ask (стрим): пробрасывает видимый текст, игнорирует reasoning', async t => {
    const client = new ChatCompletionClient(makeConfig());
    t.mock.method(
      client,
      'streamWithUsage',
      async (
        _messages: ChatMessage[],
        options: CompleteOptions,
        onDelta: (delta: StreamDelta) => void,
      ) => {
        assert.equal(options.idleTimeoutMs, 5000); // таймаут по простою
        onDelta({ reasoning: 'дум' });
        onDelta({ content: 'При' });
        onDelta({ content: 'вет' });
        return { content: 'Привет', usage: undefined };
      },
    );
    const conversation = new Conversation(client, config);
    const chunks: string[] = [];

    const result = await conversation.ask('эй', text => chunks.push(text));

    assert.deepEqual(chunks, ['При', 'вет']); // reasoning не пробрасывается
    assert.equal(result.content, 'Привет');
    assert.equal(conversation.messages.at(-1)?.content, 'Привет');
  });

  it('передаёт ограничения генерации (limits) в запрос', async t => {
    let captured: CompleteOptions | undefined;
    const client = clientWith(t, async (_messages, options) => {
      captured = options;
      return { content: 'ок', usage: undefined };
    });
    const conversation = new Conversation(client, {
      ...config,
      limits: { maxTokens: 100, responseFormat: { type: 'json_object' } },
    });
    await conversation.ask('дай json');
    assert.equal(captured?.maxTokens, 100);
    assert.deepEqual(captured?.responseFormat, { type: 'json_object' });
  });

  it('usage отсутствует — итоги не растут', async t => {
    const client = clientWith(t, async () => ({ content: 'ок', usage: undefined }));
    const conversation = new Conversation(client, config);
    await conversation.ask('раз');
    assert.deepEqual(conversation.totals, {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    });
  });

  it('обрезает историю скользящим окном по контексту агента', async t => {
    let sent: ChatMessage[] = [];
    const client = clientWith(t, async messages => {
      sent = messages;
      return { content: 'короткий', usage: undefined };
    });
    // Крошечный контекст: старая длинная реплика не влезает в окно следующего хода.
    const conversation = new Conversation(client, { ...config, contextTokens: 300 });
    await conversation.ask('ПЕРВЫЙ ' + 'а'.repeat(3000));
    await conversation.ask('второй');

    assert.equal(sent[0].role, 'system'); // системное сохраняется
    assert.ok(sent.some(m => m.content === 'второй'));
    assert.ok(!sent.some(m => m.content.includes('ПЕРВЫЙ'))); // старая реплика выпала
  });

  it('при ошибке откатывает добавленную реплику пользователя', async t => {
    const client = clientWith(t, async () => {
      throw new Error('сбой API');
    });
    const conversation = new Conversation(client, config);

    await assert.rejects(() => conversation.ask('вопрос'), /сбой API/);
    assert.deepEqual(
      conversation.messages.map(m => m.role),
      ['system'], // транскрипт не «завис» с висящей репликой
    );
  });
});
