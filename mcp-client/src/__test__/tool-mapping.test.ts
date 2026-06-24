import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toToolSpecs, extractToolText } from '../index.ts';

describe('toToolSpecs', () => {
  it('маппит инструменты, пропускает без имени/не-объекты, ставит дефолты', () => {
    const specs = toToolSpecs([
      { name: 'a', description: 'опис', inputSchema: { type: 'object' } },
      'мусор', // не объект — пропущен
      null, // null — пропущен
      { description: 'без имени' }, // нет name — пропущен
      { name: 'b' }, // без description/inputSchema → дефолты
    ]);
    assert.deepEqual(specs, [
      { name: 'a', description: 'опис', parameters: { type: 'object' } },
      { name: 'b', description: '', parameters: {} },
    ]);
  });

  it('не массив → пусто', () => {
    assert.deepEqual(toToolSpecs('нет'), []);
  });
});

describe('extractToolText', () => {
  it('склеивает текстовые блоки, пропускает прочие и пустые', () => {
    assert.equal(
      extractToolText({
        content: [
          { type: 'text', text: 'раз' },
          { type: 'image' },
          { type: 'text' },
          { type: 'text', text: 'два' },
        ],
      }),
      'раз\nдва',
    );
  });

  it('content не массив → пусто', () => {
    assert.equal(extractToolText({}), '');
  });

  it('isError → префикс ошибки', () => {
    assert.equal(
      extractToolText({ isError: true, content: [{ type: 'text', text: 'плохо' }] }),
      'Инструмент вернул ошибку: плохо',
    );
  });
});
