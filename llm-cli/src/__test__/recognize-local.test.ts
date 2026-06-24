import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LocalImageRecognizingToolSet,
  recognizeTextDirective,
  type ToolSet,
  type ToolSpec,
  type LocalFileReader,
} from '../index.ts';

/** Фейковый набор инструментов: запоминает последний вызов. */
function fakeInner(
  specs: ToolSpec[],
): ToolSet & { lastCall: { name: string; args: Record<string, unknown> } | null } {
  const inner: ToolSet & { lastCall: { name: string; args: Record<string, unknown> } | null } = {
    lastCall: null,
    specs: () => specs,
    call: async (name, args) => {
      inner.lastCall = { name, args };
      return `ok:${name}`;
    },
  };
  return inner;
}

const reader = (exists: boolean): LocalFileReader => ({
  isFile: () => exists,
  read: () => Buffer.from('БАЙТЫ'),
});

const recognizeSpec: ToolSpec = {
  name: 'yandex__recognize-text',
  description: 'распознавание',
  parameters: { type: 'object' },
};

describe('recognize-local — директива', () => {
  it('есть recognize-text → возвращает текст с правилом про неудачу', () => {
    const directive = recognizeTextDirective([recognizeSpec]);
    assert.match(directive ?? '', /Текст не удалось распознать/);
  });
  it('нет такого инструмента → null', () => {
    assert.equal(
      recognizeTextDirective([{ name: 'srv__echo', description: '', parameters: {} }]),
      null,
    );
  });
});

describe('recognize-local — обёртка локальных путей', () => {
  it('specs делегируются внутреннему набору', () => {
    const inner = fakeInner([recognizeSpec]);
    assert.deepEqual(new LocalImageRecognizingToolSet(inner, reader(true)).specs(), [
      recognizeSpec,
    ]);
  });

  it('локальный path → читается и уходит как base64 (+mimeType), path убран', async () => {
    const inner = fakeInner([recognizeSpec]);
    const toolSet = new LocalImageRecognizingToolSet(inner, reader(true));
    const result = await toolSet.call('yandex__recognize-text', {
      path: '/x/a.png',
      model: 'page',
    });
    assert.equal(result, 'ok:yandex__recognize-text');
    assert.equal(inner.lastCall?.args.path, undefined);
    assert.equal(inner.lastCall?.args.base64, Buffer.from('БАЙТЫ').toString('base64'));
    assert.equal(inner.lastCall?.args.mimeType, 'image/png');
    assert.equal(inner.lastCall?.args.model, 'page'); // прочие поля сохранены
  });

  it('явный mimeType не перетирается', async () => {
    const inner = fakeInner([recognizeSpec]);
    const toolSet = new LocalImageRecognizingToolSet(inner, reader(true));
    await toolSet.call('yandex__recognize-text', { path: '/x/a.png', mimeType: 'image/custom' });
    assert.equal(inner.lastCall?.args.mimeType, 'image/custom');
  });

  it('незнакомое расширение → mimeType не добавляется', async () => {
    const inner = fakeInner([recognizeSpec]);
    const toolSet = new LocalImageRecognizingToolSet(inner, reader(true));
    await toolSet.call('yandex__recognize-text', { path: '/x/a.bin' });
    assert.equal('mimeType' in (inner.lastCall?.args ?? {}), false);
  });

  it('нет файла → ошибка пробрасывается', async () => {
    const inner = fakeInner([recognizeSpec]);
    const toolSet = new LocalImageRecognizingToolSet(inner, reader(false));
    await assert.rejects(
      () => toolSet.call('yandex__recognize-text', { path: '/x/нет.png' }),
      /файл не найден/,
    );
  });

  it('url (без path) проходит насквозь', async () => {
    const inner = fakeInner([recognizeSpec]);
    const toolSet = new LocalImageRecognizingToolSet(inner, reader(true));
    await toolSet.call('yandex__recognize-text', { url: 'https://e/x.png' });
    assert.deepEqual(inner.lastCall?.args, { url: 'https://e/x.png' });
  });

  it('пустой path проходит насквозь (не локальный файл)', async () => {
    const inner = fakeInner([recognizeSpec]);
    const toolSet = new LocalImageRecognizingToolSet(inner, reader(true));
    await toolSet.call('yandex__recognize-text', { path: '   ' });
    assert.deepEqual(inner.lastCall?.args, { path: '   ' });
  });

  it('другой инструмент с path не трогается', async () => {
    const inner = fakeInner([recognizeSpec]);
    const toolSet = new LocalImageRecognizingToolSet(inner, reader(true));
    await toolSet.call('srv__echo', { path: '/x/a.png' });
    assert.deepEqual(inner.lastCall?.args, { path: '/x/a.png' });
  });

  it('по умолчанию использует реальный nodeFileReader (несуществующий путь → ошибка)', async () => {
    const inner = fakeInner([recognizeSpec]);
    const toolSet = new LocalImageRecognizingToolSet(inner);
    await assert.rejects(
      () => toolSet.call('yandex__recognize-text', { path: '/nope/несуществует-9999.png' }),
      /файл не найден/,
    );
  });
});
