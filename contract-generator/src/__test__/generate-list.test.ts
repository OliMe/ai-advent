import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseGenerateArgs, generateMany, runGenerate, DEFAULT_MODEL } from '../generate-list.ts';
import { makeClient, makeCollector } from './helpers.ts';

/** Заглушка: возвращает текст пользовательского сообщения (содержит «Договор №seed»). */
const echoSeed = async (messages: { content: string }[]) => messages[1].content;

describe('parseGenerateArgs', () => {
  it('возвращает значения по умолчанию', () => {
    const options = parseGenerateArgs([]);
    assert.equal(options.count, 10);
    assert.equal(options.maxTokens, 600);
    assert.equal(options.concurrency, 2);
    assert.equal(options.perRequest, 1);
    assert.equal(options.model, DEFAULT_MODEL);
    assert.equal(options.out, undefined);
  });

  it('читает все флаги (форма = и пробел)', () => {
    const options = parseGenerateArgs([
      '--count=100',
      '--per-request=5',
      '--max-tokens',
      '400',
      '--concurrency=8',
      '--model=glm-4.6',
      '--out=out.txt',
    ]);
    assert.equal(options.count, 100);
    assert.equal(options.perRequest, 5);
    assert.equal(options.maxTokens, 400);
    assert.equal(options.concurrency, 8);
    assert.equal(options.model, 'glm-4.6');
    assert.equal(options.out, 'out.txt');
  });

  it('бросает ошибку при невалидном числовом флаге', () => {
    assert.throws(() => parseGenerateArgs(['--count=0']), /положительн/);
  });

  it('бросает ошибку, если у флага нет значения', () => {
    assert.throws(() => parseGenerateArgs(['--count']), /Не указано значение/);
  });

  it('бросает ошибку на неизвестном флаге', () => {
    assert.throws(() => parseGenerateArgs(['--oops=1']), /Неизвестный флаг/);
  });
});

describe('generateMany', () => {
  it('режим стоп-маркера (perRequest=1): по договору на запрос, порядок сохранён', async t => {
    const client = makeClient(t, echoSeed);
    const result = await generateMany(client, 3, 1, 400, 2, 60000);
    assert.equal(result.length, 3);
    assert.match(result[0], /Договор №1/);
    assert.match(result[2], /Договор №3/);
  });

  it('пакетный режим (perRequest>1): один запрос на пакет', async t => {
    const client = makeClient(t, async () => 'К1=====К2');
    const result = await generateMany(client, 2, 2, 400, 2, 60000);
    assert.deepEqual(result, ['К1', 'К2']);
  });

  it('пакетный режим: дробит на пакеты и не превышает count', async t => {
    const client = makeClient(t, async () => 'A=====B');
    const result = await generateMany(client, 3, 2, 400, 2, 60000);
    assert.equal(result.length, 3); // пакеты [2,1] вернули по 2 → обрезано до 3
  });
});

describe('runGenerate', () => {
  it('пишет договоры через разделитель =====', async t => {
    const client = makeClient(t, echoSeed);
    const output = makeCollector();

    await runGenerate(
      { count: 2, maxTokens: 400, concurrency: 2, perRequest: 1, model: DEFAULT_MODEL },
      client,
      60000,
      output.stream,
    );

    const parts = output.text().trim().split('\n=====\n');
    assert.equal(parts.length, 2);
    assert.match(parts[0], /Договор №1/);
    assert.match(parts[1], /Договор №2/);
  });
});
