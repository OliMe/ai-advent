import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Conversation } from '../index.ts';
import type { ConversationConfig } from '../index.ts';
import { ChatCompletionClient } from '../index.ts';
import type { ChatMessage, CompleteOptions, StreamDelta, ToolSet, Usage } from '../index.ts';
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

describe('Conversation — агентный цикл (инструменты)', () => {
  const toolCall = (name: string, args: string) => ({
    id: 'c1',
    type: 'function' as const,
    function: { name, arguments: args },
  });

  it('вызывает инструмент, возвращает результат модели и финальный ответ', async t => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const reported: string[] = [];
    const tools: ToolSet = {
      specs: () => [{ name: 'add', description: 'сумма', parameters: { type: 'object' } }],
      call: async (name, args) => {
        calls.push({ name, args });
        return '3';
      },
    };
    let round = 0;
    const usage: Usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
    const client = clientWith(t, async () => {
      round++;
      return round === 1
        ? { content: '', toolCalls: [toolCall('add', '{"a":1,"b":2}')], usage }
        : { content: 'Сумма равна 3', usage };
    });
    const conversation = new Conversation(client, {
      ...config,
      tools,
      onToolCall: name => reported.push(name),
    });

    const result = await conversation.ask('сложи 1 и 2');

    assert.equal(result.content, 'Сумма равна 3');
    assert.deepEqual(calls, [{ name: 'add', args: { a: 1, b: 2 } }]); // аргументы разобраны
    assert.deepEqual(reported, ['add']); // вызов инструмента сообщён
    assert.deepEqual(
      conversation.messages.map(m => m.role),
      ['system', 'user', 'assistant', 'tool', 'assistant'],
    );
    assert.equal(conversation.messages[3].tool_call_id, 'c1');
    assert.equal(conversation.messages[3].content, '3');
    assert.deepEqual(conversation.totals, {
      prompt_tokens: 2,
      completion_tokens: 2,
      total_tokens: 4,
    });
  });

  it('tool-цикл с заданным limits: бюджет offload берёт из maxTokens (ветка limits?.maxTokens)', async t => {
    const tools: ToolSet = {
      specs: () => [{ name: 'noop', description: 'x', parameters: { type: 'object' } }],
      call: async () => 'готово',
    };
    let round = 0;
    const client = clientWith(t, async () => {
      round++;
      return round === 1
        ? { content: '', toolCalls: [toolCall('noop', '{}')], usage: undefined }
        : { content: 'финал', usage: undefined };
    });
    const conversation = new Conversation(client, {
      ...config,
      tools,
      limits: { maxTokens: 50 }, // limits задан → берётся defined-ветка при вычислении бюджета offload
    });
    assert.equal((await conversation.ask('давай')).content, 'финал');
  });

  it('ошибка инструмента и пустые аргументы: возвращает текст ошибки модели, цикл идёт дальше', async t => {
    const tools: ToolSet = {
      specs: () => [{ name: 'bad', description: 'x', parameters: {} }],
      call: async () => {
        throw new Error('сломалось');
      },
    };
    let round = 0;
    const client = clientWith(t, async () => {
      round++;
      return round === 1
        ? { content: '', toolCalls: [toolCall('bad', '')], usage: undefined } // пустые аргументы
        : { content: 'готово', usage: undefined };
    });
    const conversation = new Conversation(client, { ...config, tools });

    const result = await conversation.ask('сделай');

    assert.equal(result.content, 'готово');
    const toolMessage = conversation.messages.find(message => message.role === 'tool');
    assert.match(toolMessage?.content ?? '', /Ошибка инструмента «bad»: сломалось/);
  });

  it('не-Error из инструмента тоже превращается в текст ошибки', async t => {
    const tools: ToolSet = {
      specs: () => [{ name: 'x', description: '', parameters: {} }],
      call: async () => {
        throw 'строковый сбой'; // брошено не-Error значение
      },
    };
    let round = 0;
    const client = clientWith(t, async () => {
      round++;
      return round === 1
        ? { content: '', toolCalls: [toolCall('x', '{}')], usage: undefined }
        : { content: 'ок', usage: undefined };
    });
    const conversation = new Conversation(client, { ...config, tools });

    await conversation.ask('go');

    const toolMessage = conversation.messages.find(message => message.role === 'tool');
    assert.match(toolMessage?.content ?? '', /строковый сбой/);
  });

  it('инструменты заданы, но список пуст → обычный одиночный запрос', async t => {
    const tools: ToolSet = { specs: () => [], call: async () => '' };
    const client = clientWith(t, async () => ({ content: 'обычный ответ', usage: undefined }));
    const conversation = new Conversation(client, { ...config, tools });

    const result = await conversation.ask('привет');

    assert.equal(result.content, 'обычный ответ');
    assert.deepEqual(
      conversation.messages.map(m => m.role),
      ['system', 'user', 'assistant'], // tool-сообщений нет
    );
  });

  it('превышение лимита раундов инструментов → ошибка и откат хода', async t => {
    const tools: ToolSet = {
      specs: () => [{ name: 'loop', description: 'x', parameters: {} }],
      call: async () => 'ещё',
    };
    const client = clientWith(t, async () => ({
      content: '',
      toolCalls: [toolCall('loop', '{}')],
      usage: undefined,
    }));
    const conversation = new Conversation(client, { ...config, tools, maxToolRounds: 2 });

    await assert.rejects(() => conversation.ask('зацикли'), /Превышен лимит раундов/);
    assert.deepEqual(
      conversation.messages.map(m => m.role),
      ['system'], // ход полностью откатан
    );
  });
});
