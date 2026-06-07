import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  toTargets,
  fromHfModels,
  formatParams,
  formatResults,
  generateAll,
  type ModelResult,
  type TargetModel,
} from '../generate.ts';
import {
  ChatCompletionClient,
  type CompleteOptions,
  type ChatMessage,
} from '../../../core/src/index.ts';
import { makeFactory, makeConfig } from './helpers.ts';

describe('toTargets', () => {
  it('строит цели с ссылками из id', () => {
    assert.deepEqual(toTargets(['a/b']), [
      { apiId: 'a/b', id: 'a/b', url: 'https://huggingface.co/a/b' },
    ]);
  });

  it('суффикс провайдера уходит в apiId, а id и ссылка — без него', () => {
    assert.deepEqual(toTargets(['a/b:featherless-ai']), [
      { apiId: 'a/b:featherless-ai', id: 'a/b', url: 'https://huggingface.co/a/b' },
    ]);
  });
});

describe('fromHfModels', () => {
  it('закрепляет провайдера в apiId', () => {
    const result = fromHfModels([
      { id: 'a/b', url: 'https://huggingface.co/a/b', params: 1000, provider: 'featherless-ai' },
    ]);
    assert.deepEqual(result, [
      { apiId: 'a/b:featherless-ai', id: 'a/b', url: 'https://huggingface.co/a/b', params: 1000 },
    ]);
  });
});

describe('formatParams', () => {
  it('миллиарды — в B, миллионы — в M', () => {
    assert.equal(formatParams(7_615_616_512), '7.6 B');
    assert.equal(formatParams(751_632_384), '752 M');
  });
});

describe('generateAll', () => {
  it('опрашивает модели параллельно; ошибка одной не роняет остальные', async t => {
    const factory = makeFactory(t, async id => {
      if (id === 'bad') throw new Error('недоступна');
      if (id === 'str') throw 'строковый сбой';
      return `ответ ${id}`;
    });
    const models: TargetModel[] = [
      { apiId: 'good', id: 'good', url: 'u1' },
      { apiId: 'bad', id: 'bad', url: 'u2' },
      { apiId: 'str', id: 'str', url: 'u3' },
    ];

    const results = await generateAll(factory, models, 'привет', 60000);

    assert.equal(results[0].text, 'ответ good');
    assert.deepEqual(results[0].usage, { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
    assert.equal(typeof results[0].elapsedMs, 'number');
    assert.equal(results[1].error, 'недоступна'); // Error → message
    assert.equal(typeof results[1].elapsedMs, 'number'); // время меряется и при ошибке
    assert.equal(results[2].error, 'строковый сбой'); // не-Error → String()
  });

  it('задаёт дефолтный max_tokens (без него провайдеры подставляют 0 и падают)', async t => {
    let capturedOptions: CompleteOptions | undefined;
    const client = new ChatCompletionClient(makeConfig());
    t.mock.method(
      client,
      'completeWithUsage',
      async (_messages: ChatMessage[], options: CompleteOptions) => {
        capturedOptions = options;
        return {
          content: 'ок',
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        };
      },
    );

    await generateAll(() => client, [{ apiId: 'a/b', id: 'a/b', url: 'u' }], 'p', 60000);

    assert.equal(capturedOptions?.maxTokens, 1024);
  });

  it('повторяет маршрут после сбоя и возвращает ответ', async t => {
    let calls = 0;
    const factory = makeFactory(t, async route => {
      calls++;
      if (calls === 1) throw new Error('блип провайдера'); // первый запрос моргнул
      return `ответ ${route}`;
    });

    const results = await generateAll(
      factory,
      [{ apiId: 'm/x:prov', id: 'm/x', url: 'u' }],
      'p',
      60000,
    );

    assert.equal(results[0].text, 'ответ m/x:prov'); // повтор того же закреплённого маршрута
    assert.equal(calls, 2);
  });

  it('повторяет только пин и отдаёт честную ошибку, не уходя на голый id', async t => {
    const routes: string[] = [];
    const factory = makeFactory(t, async route => {
      routes.push(route);
      throw new Error('provider not valid'); // ошибка именно пин-провайдера
    });

    const results = await generateAll(
      factory,
      [{ apiId: 'm/x:prov', id: 'm/x', url: 'u' }],
      'p',
      60000,
    );

    assert.deepEqual(routes, ['m/x:prov', 'm/x:prov']); // только пин, дважды; голый id не пробуем
    assert.equal(results[0].error, 'provider not valid'); // честная ошибка пина, не bare «not supported»
  });
});

describe('formatResults', () => {
  it('печатает id, размер, ссылку, метрики и ответ либо ошибку', () => {
    const results: ModelResult[] = [
      {
        model: {
          apiId: 'big/m:prov',
          id: 'big/m',
          url: 'https://huggingface.co/big/m',
          params: 7_000_000_000,
        },
        text: 'привет',
        elapsedMs: 1200,
        usage: { prompt_tokens: 3, completion_tokens: 10, total_tokens: 13 },
      },
      {
        model: { apiId: 'manual/m', id: 'manual/m', url: 'https://huggingface.co/manual/m' },
        error: 'таймаут',
        elapsedMs: 500,
      },
    ];
    const text = formatResults(results);
    // успех: размер, метрики с токенами, текст
    assert.match(text, /### big\/m — 7\.0 B/);
    assert.match(text, /время: 1\.2 c · токены: вход 3, выход 10, всего 13\n\nпривет/);
    // ошибка: метрики без токенов (н/д) и текст ошибки
    assert.match(
      text,
      /### manual\/m\nhttps:\/\/huggingface\.co\/manual\/m\nвремя: 0\.5 c · токены: н\/д\n\n\[ошибка\] таймаут/,
    );
  });
});
