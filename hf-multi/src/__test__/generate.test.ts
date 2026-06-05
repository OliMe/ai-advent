import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  toTargets,
  formatParams,
  formatResults,
  generateAll,
  type ModelResult,
  type TargetModel,
} from '../generate.ts';
import { makeFactory } from './helpers.ts';

describe('toTargets', () => {
  it('строит цели с ссылками из id', () => {
    assert.deepEqual(toTargets(['a/b']), [{ id: 'a/b', url: 'https://huggingface.co/a/b' }]);
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
      { id: 'good', url: 'u1' },
      { id: 'bad', url: 'u2' },
      { id: 'str', url: 'u3' },
    ];

    const results = await generateAll(factory, models, 'привет', 60000);

    assert.equal(results[0].text, 'ответ good');
    assert.equal(results[0].error, undefined);
    assert.equal(results[1].error, 'недоступна'); // Error → message
    assert.equal(results[2].error, 'строковый сбой'); // не-Error → String()
  });
});

describe('formatResults', () => {
  it('печатает id, размер, ссылку и ответ либо ошибку', () => {
    const results: ModelResult[] = [
      {
        model: { id: 'big/m', url: 'https://huggingface.co/big/m', params: 7_000_000_000 },
        text: 'привет',
      },
      { model: { id: 'manual/m', url: 'https://huggingface.co/manual/m' }, error: 'таймаут' },
    ];
    const text = formatResults(results);
    assert.match(text, /### big\/m — 7\.0 B\nhttps:\/\/huggingface\.co\/big\/m\n\nпривет/);
    assert.match(text, /### manual\/m\nhttps:\/\/huggingface\.co\/manual\/m\n\n\[ошибка\] таймаут/);
  });
});
