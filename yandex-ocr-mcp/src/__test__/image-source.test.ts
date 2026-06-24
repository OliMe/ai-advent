import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { inferMimeType, resolveImage } from '../index.ts';
import type { ImageReaders } from '../index.ts';

/** Читатели-заглушки: файл и URL отдают фиксированный буфер. */
function readers(contentType?: string): ImageReaders {
  return {
    readFile: async () => Buffer.from('файл'),
    fetchUrl: async () => ({ buffer: Buffer.from('сеть'), contentType }),
  };
}

describe('inferMimeType', () => {
  it('по расширению, регистронезависимо; неизвестное/без расширения — undefined', () => {
    assert.equal(inferMimeType('a.PNG'), 'image/png');
    assert.equal(inferMimeType('scan.jpeg'), 'image/jpeg');
    assert.equal(inferMimeType('doc.pdf'), 'application/pdf');
    assert.equal(inferMimeType('image.gif'), undefined); // расширение есть, но не поддержано
    assert.equal(inferMimeType('noext'), undefined);
  });
});

describe('resolveImage — источник path', () => {
  it('base64 файла; mimeType: явный / по расширению / дефолт', async () => {
    const expected = Buffer.from('файл').toString('base64');
    assert.deepEqual(await resolveImage({ path: 'a.png' }, readers()), {
      content: expected,
      mimeType: 'image/png',
    });
    assert.equal((await resolveImage({ path: 'a.bin' }, readers())).mimeType, 'image/jpeg'); // дефолт
    assert.equal(
      (await resolveImage({ path: 'a.png', mimeType: 'image/custom' }, readers())).mimeType,
      'image/custom', // явный важнее
    );
  });
});

describe('resolveImage — источник url', () => {
  it('mimeType: явный / по расширению / из Content-Type / дефолт', async () => {
    assert.equal((await resolveImage({ url: 'http://x/y.png' }, readers())).mimeType, 'image/png');
    assert.equal(
      (await resolveImage({ url: 'http://x/y' }, readers('image/webp'))).mimeType,
      'image/webp', // нет расширения → Content-Type
    );
    assert.equal((await resolveImage({ url: 'http://x/y' }, readers())).mimeType, 'image/jpeg'); // дефолт
    assert.equal(
      (await resolveImage({ url: 'http://x/y', mimeType: 'image/explicit' }, readers('image/webp')))
        .mimeType,
      'image/explicit',
    );
    assert.equal(
      (await resolveImage({ url: 'http://x/y' }, readers())).content,
      Buffer.from('сеть').toString('base64'),
    );
  });
});

describe('resolveImage — источник base64', () => {
  it('содержимое как есть; mimeType явный или дефолт', async () => {
    assert.deepEqual(await resolveImage({ base64: 'QUJD' }, readers()), {
      content: 'QUJD',
      mimeType: 'image/jpeg',
    });
    assert.equal(
      (await resolveImage({ base64: 'QUJD', mimeType: 'image/png' }, readers())).mimeType,
      'image/png',
    );
  });
});

describe('resolveImage — валидация источника', () => {
  it('ни одного источника — ошибка', async () => {
    await assert.rejects(() => resolveImage({}, readers()), /Не задан источник/);
  });

  it('более одного источника — ошибка', async () => {
    await assert.rejects(
      () => resolveImage({ path: 'a.png', url: 'http://x/y' }, readers()),
      /только один источник/,
    );
  });
});
