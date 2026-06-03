import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatCompletionClient } from '../../../core/src/index.ts';
import {
  buildExtractionMessages,
  extractionLimits,
  parseContracts,
  extractBatch,
  buildListMessages,
  parseList,
  listBatch,
} from '../extract.ts';
import { makeClient } from './helpers.ts';

const ONE = '{"contracts":[{"landlord":{"name":"A"},"tenant":{"name":"B"}}]}';

describe('buildExtractionMessages', () => {
  it('просит вернуть только первые N, когда нужно меньше, чем в пакете', () => {
    const messages = buildExtractionMessages(['c1', 'c2'], 1);
    assert.match(messages[1].content, /только для первых 1/);
    assert.match(messages[0].content, /JSON Schema/);
  });

  it('просит вернуть по объекту на каждый договор, когда нужны все', () => {
    const messages = buildExtractionMessages(['c1', 'c2'], 2);
    assert.match(messages[1].content, /по объекту на каждый/);
  });
});

describe('extractionLimits', () => {
  it('собирает лимит длины, json_schema и стоп-страховку', () => {
    const limits = extractionLimits(500);
    assert.equal(limits.maxTokens, 500);
    assert.equal(limits.responseFormat?.type, 'json_schema');
    assert.ok(Array.isArray(limits.stop));
  });
});

describe('parseContracts', () => {
  it('извлекает массив contracts из чистого JSON', () => {
    assert.equal(parseContracts(ONE).length, 1);
  });

  it('игнорирует ограждения и хвост вокруг JSON', () => {
    const raw = '```json\n' + ONE + '\n```\n<<<DONE>>>';
    assert.equal(parseContracts(raw).length, 1);
  });

  it('бросает ошибку, если JSON-объект не найден', () => {
    assert.throws(() => parseContracts('нет тут json'), /не найден JSON-объект/);
  });

  it('бросает ошибку при отсутствии закрывающей скобки', () => {
    assert.throws(() => parseContracts('{ начало без конца'), /не найден JSON-объект/);
  });

  it('бросает ошибку, если скобки в обратном порядке', () => {
    assert.throws(() => parseContracts('}{'), /не найден JSON-объект/);
  });

  it('бросает ошибку при невалидном JSON', () => {
    assert.throws(() => parseContracts('{плохой json}'), /Не удалось разобрать JSON/);
  });

  it('бросает ошибку, если нет поля contracts', () => {
    assert.throws(() => parseContracts('{"x":1}'), /нет поля contracts/);
  });
});

describe('extractBatch', () => {
  it('передаёт ограничения клиенту и возвращает разобранные договоры', async t => {
    let capturedOptions: Parameters<ChatCompletionClient['complete']>[1];
    const client = makeClient(t, async (_messages, options) => {
      capturedOptions = options;
      return ONE;
    });

    const result = await extractBatch(client, ['c1', 'c2'], 1, 700, 60000, true);

    assert.equal(result.length, 1);
    assert.ok(capturedOptions?.signal instanceof AbortSignal);
    assert.equal(capturedOptions?.maxTokens, 700);
    assert.equal(capturedOptions?.responseFormat?.type, 'json_schema');
    assert.equal(capturedOptions?.disableThinking, true);
  });
});

describe('buildListMessages / parseList', () => {
  it('строит сообщения с указанием разделителя', () => {
    const messages = buildListMessages(['c1']);
    assert.match(messages[1].content, /<<<NEXT>>>/);
    assert.equal(messages[0].role, 'system');
  });

  it('делит ответ по разделителю и отбрасывает пустые блоки', () => {
    assert.deepEqual(parseList('Блок 1<<<NEXT>>>Блок 2<<<NEXT>>>  '), ['Блок 1', 'Блок 2']);
  });
});

describe('listBatch', () => {
  it('возвращает текстовые блоки без ограничений формата', async t => {
    let capturedOptions: Parameters<ChatCompletionClient['complete']>[1];
    const client = makeClient(t, async (_messages, options) => {
      capturedOptions = options;
      return 'A<<<NEXT>>>B';
    });

    const result = await listBatch(client, ['c1', 'c2'], 60000);

    assert.deepEqual(result, ['A', 'B']);
    assert.ok(capturedOptions?.signal instanceof AbortSignal);
    assert.equal(capturedOptions?.maxTokens, undefined);
    assert.equal(capturedOptions?.responseFormat, undefined);
  });
});
