import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as readline from 'node:readline/promises';
import { PassThrough } from 'node:stream';
import { parseModels, parseMaxTokens, runMulti, runOnce } from '../run.ts';
import type { TargetModel } from '../generate.ts';
import { makeFactory, makeConfig, makeCollector } from './helpers.ts';

const MODELS: TargetModel[] = [
  { apiId: 'big/m', id: 'big/m', url: 'https://huggingface.co/big/m', params: 7_000_000_000 },
  { apiId: 'small/m', id: 'small/m', url: 'https://huggingface.co/small/m', params: 1_000_000 },
];

/** Прогоняет сценарий, отвечая на приглашения «Сменить модели?» и «Промпт:». */
function driveMulti(
  makeClient: ReturnType<typeof makeFactory>,
  models: TargetModel[],
  lines: string[],
): { finished: Promise<void>; text: () => string } {
  const input = new PassThrough();
  let buffer = '';
  let next = 0;
  const output = new PassThrough();
  output.on('data', chunk => {
    const text = chunk.toString();
    buffer += text;
    if ((text.includes('Сменить модели?') || text.includes('Промпт:')) && next < lines.length) {
      const line = lines[next++];
      setImmediate(() => input.write(line + '\n'));
    }
  });
  const finished = runMulti(
    makeConfig(),
    models,
    makeClient,
    input,
    output,
    readline.createInterface,
  );
  return { finished, text: () => buffer };
}

describe('parseModels', () => {
  it('делит по запятой, обрезает и отбрасывает пустые', () => {
    assert.deepEqual(parseModels('a/b, c/d ,, e/f '), ['a/b', 'c/d', 'e/f']);
  });
});

describe('parseMaxTokens', () => {
  it('возвращает положительное целое', () => {
    assert.equal(parseMaxTokens('500'), 500);
  });

  it('возвращает undefined, если флаг не задан', () => {
    assert.equal(parseMaxTokens(undefined), undefined);
  });

  it('возвращает undefined при некорректном значении (не число, ноль, дробь)', () => {
    assert.equal(parseMaxTokens('abc'), undefined);
    assert.equal(parseMaxTokens('0'), undefined);
    assert.equal(parseMaxTokens('12.5'), undefined);
  });
});

describe('runMulti', () => {
  it('оставляет выбранные модели и печатает их ответы', async t => {
    const factory = makeFactory(t, async id => `ОТВЕТ ${id}`);
    const { finished, text } = driveMulti(factory, MODELS, ['', 'Привет']);
    await finished;

    assert.match(text(), /### big\/m/);
    assert.match(text(), /ОТВЕТ big\/m/);
    assert.match(text(), /ОТВЕТ small\/m/);
  });

  it('меняет модели по вводу пользователя', async t => {
    const factory = makeFactory(t, async id => `ОТВЕТ ${id}`);
    const { finished, text } = driveMulti(factory, MODELS, ['custom/x, custom/y', 'Привет']);
    await finished;

    assert.match(text(), /### custom\/x/);
    assert.match(text(), /### custom\/y/);
    assert.doesNotMatch(text(), /ОТВЕТ big\/m/);
  });

  it('сообщает, если промпт пуст', async t => {
    const factory = makeFactory(t, async () => 'не-важно');
    const { finished, text } = driveMulti(factory, MODELS, ['', '']);
    await finished;

    assert.match(text(), /Промпт не указан/);
  });
});

describe('runOnce', () => {
  it('печатает модели и их ответы без интерактива', async t => {
    const factory = makeFactory(t, async id => `ОТВЕТ ${id}`);
    const { stream, text } = makeCollector();

    await runOnce(makeConfig(), MODELS, factory, stream, 'Привет');

    assert.match(text(), /Модели:/);
    assert.match(text(), /### big\/m/);
    assert.match(text(), /ОТВЕТ big\/m/);
    assert.match(text(), /ОТВЕТ small\/m/);
  });
});
