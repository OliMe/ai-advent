import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatCompletionClient } from '../../../core/src/index.ts';
import {
  buildGenerationMessages,
  generationLimits,
  cleanContract,
  generateOne,
  buildBatchMessages,
  parseBatch,
  generateBatch,
} from '../generate.ts';
import { makeClient } from './helpers.ts';

describe('buildGenerationMessages', () => {
  it('подставляет seed и держит стабильный системный промпт', () => {
    const messages = buildGenerationMessages(7);
    assert.equal(messages[0].role, 'system');
    assert.match(messages[0].content, /<<<КОНЕЦ>>>/);
    assert.match(messages[1].content, /Договор №7/);
  });
});

describe('generationLimits', () => {
  it('задаёт лимит длины и стоп-маркер', () => {
    const limits = generationLimits(300);
    assert.equal(limits.maxTokens, 300);
    assert.deepEqual(limits.stop, ['<<<КОНЕЦ>>>']);
  });
});

describe('cleanContract', () => {
  it('обрезает текст по полному стоп-маркеру', () => {
    assert.equal(cleanContract('Текст договора <<<КОНЕЦ>>> хвост'), 'Текст договора');
  });

  it('обрезает и неполный маркер (модель не дописала >>>)', () => {
    assert.equal(cleanContract('Текст договора\n<<<КОНЕЦ'), 'Текст договора');
  });

  it('возвращает обрезанный текст, если маркера нет', () => {
    assert.equal(cleanContract('  Текст договора  '), 'Текст договора');
  });
});

describe('generateOne', () => {
  it('отключает рассуждения, ставит стоп и чистит ответ', async t => {
    let capturedOptions: Parameters<ChatCompletionClient['complete']>[1];
    const client = makeClient(t, async (_messages, options) => {
      capturedOptions = options;
      return 'Договор аренды... <<<КОНЕЦ>>>';
    });

    const result = await generateOne(client, 1, 400, 60000);

    assert.equal(result, 'Договор аренды...');
    assert.equal(capturedOptions?.disableThinking, true);
    assert.deepEqual(capturedOptions?.stop, ['<<<КОНЕЦ>>>']);
    assert.equal(capturedOptions?.maxTokens, 400);
    assert.ok(capturedOptions?.signal instanceof AbortSignal);
  });
});

describe('buildBatchMessages', () => {
  it('просит нужное число договоров и указывает разделитель', () => {
    const messages = buildBatchMessages(3, 5);
    assert.equal(messages[0].role, 'system');
    assert.match(messages[1].content, /Сгенерируй 3/);
    assert.match(messages[1].content, /№5–7/);
    assert.match(messages[1].content, /=====/);
  });
});

describe('parseBatch', () => {
  it('делит ответ по разделителю и отбрасывает пустые', () => {
    assert.deepEqual(parseBatch('Договор A=====Договор B=====  '), ['Договор A', 'Договор B']);
  });
});

describe('generateBatch', () => {
  it('масштабирует лимит на число договоров, без стоп-маркера', async t => {
    let capturedOptions: Parameters<ChatCompletionClient['complete']>[1];
    const client = makeClient(t, async (_messages, options) => {
      capturedOptions = options;
      return 'К1=====К2';
    });

    const result = await generateBatch(client, 2, 1, 300, 60000);

    assert.deepEqual(result, ['К1', 'К2']);
    assert.equal(capturedOptions?.disableThinking, true);
    assert.equal(capturedOptions?.maxTokens, 600); // 300 × 2
    assert.equal(capturedOptions?.stop, undefined);
    assert.ok(capturedOptions?.signal instanceof AbortSignal);
  });
});
