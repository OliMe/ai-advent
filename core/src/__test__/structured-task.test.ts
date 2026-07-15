import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { schemaPromptEcho, completeStructured } from '../index.ts';
import type { JsonSchemaSpec, CompleteOptions, ChatMessage } from '../index.ts';
import { clientWith } from './helpers.ts';

const SCHEMA: JsonSchemaSpec = {
  name: 'demo',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { value: { type: 'string' } },
    required: ['value'],
  },
};

const MESSAGES: ChatMessage[] = [{ role: 'user', content: 'дай объект' }];

describe('schemaPromptEcho', () => {
  it('вкладывает схему текстом с требованием строгого JSON', () => {
    const echo = schemaPromptEcho(SCHEMA);
    assert.match(echo, /СТРОГО одним JSON-объектом/);
    assert.match(echo, /"additionalProperties": false/);
  });
});

describe('completeStructured', () => {
  it('разбирает чистый JSON и передаёт таймаут-сигнал', async t => {
    let seen: CompleteOptions | undefined;
    const client = clientWith(t, (_messages, options) => {
      seen = options;
      return { content: '{"value":"ок"}' };
    });

    const result = await completeStructured(client, MESSAGES, {
      schema: SCHEMA,
      requestTimeoutMs: 1000,
    });

    assert.deepEqual(result, { value: 'ок' });
    assert.ok(seen?.signal instanceof AbortSignal);
    // Тумблер выключен → response_format в запрос НЕ уходит (безопасно для z.ai/GLM).
    assert.equal(seen?.responseFormat, undefined);
    // Необязательные поля не заданы → не подмешиваются.
    assert.equal(seen?.temperature, undefined);
    assert.equal(seen?.disableThinking, undefined);
    assert.equal(seen?.maxTokens, undefined);
    assert.equal(seen?.stop, undefined);
  });

  it('вынимает объект из прозы/markdown-ограждения', async t => {
    const client = clientWith(t, () => ({
      content: 'Вот результат:\n```json\n{"value":"из markdown"}\n```\nготово',
    }));
    const result = await completeStructured(client, MESSAGES, {
      schema: SCHEMA,
      requestTimeoutMs: 1000,
    });
    assert.deepEqual(result, { value: 'из markdown' });
  });

  it('при включённом тумблере кладёт response_format и прокидывает опции', async t => {
    let seen: CompleteOptions | undefined;
    const client = clientWith(t, (_messages, options) => {
      seen = options;
      return { content: '{"value":"x"}' };
    });

    await completeStructured(client, MESSAGES, {
      schema: SCHEMA,
      structuredOutputs: true,
      maxTokens: 500,
      stop: ['СТОП'],
      temperature: 0.2,
      disableThinking: true,
      requestTimeoutMs: 1000,
    });

    assert.deepEqual(seen?.responseFormat, { type: 'json_schema', json_schema: SCHEMA });
    assert.equal(seen?.maxTokens, 500);
    assert.deepEqual(seen?.stop, ['СТОП']);
    assert.equal(seen?.temperature, 0.2);
    assert.equal(seen?.disableThinking, true);
  });

  it('битый ответ — говорящая ошибка (не тихий null)', async t => {
    const client = clientWith(t, () => ({ content: 'извините, не могу' }));
    await assert.rejects(
      completeStructured(client, MESSAGES, { schema: SCHEMA, requestTimeoutMs: 1000 }),
      /Не удалось разобрать JSON.*maxTokens/s,
    );
  });
});
