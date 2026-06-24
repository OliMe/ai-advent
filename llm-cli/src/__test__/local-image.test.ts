import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync, rmSync } from 'node:fs';
import {
  inferImageMimeType,
  expandHomeDirectory,
  readLocalImageAsBase64,
  nodeFileReader,
  type LocalFileReader,
} from '../index.ts';

describe('local-image — MIME по расширению', () => {
  it('узнаёт картинки (регистр не важен)', () => {
    assert.equal(inferImageMimeType('/a/b.PNG'), 'image/png');
    assert.equal(inferImageMimeType('scan.jpeg'), 'image/jpeg');
    assert.equal(inferImageMimeType('doc.pdf'), 'application/pdf');
  });
  it('для незнакомого расширения — undefined', () => {
    assert.equal(inferImageMimeType('file.bin'), undefined);
  });
});

describe('local-image — разворот тильды', () => {
  it('одна тильда → домашний каталог', () => {
    assert.equal(expandHomeDirectory('~'), homedir());
  });
  it('~/путь → внутрь домашнего каталога', () => {
    assert.equal(expandHomeDirectory('~/pics/a.png'), join(homedir(), 'pics/a.png'));
  });
  it('обычный путь не меняется', () => {
    assert.equal(expandHomeDirectory('/tmp/a.png'), '/tmp/a.png');
  });
});

describe('local-image — чтение в base64', () => {
  const fakeReader = (exists: boolean, content = 'данные'): LocalFileReader => ({
    isFile: () => exists,
    read: () => Buffer.from(content),
  });

  it('читает файл и определяет MIME', () => {
    const result = readLocalImageAsBase64('/x/a.png', fakeReader(true, 'abc'));
    assert.equal(result.base64, Buffer.from('abc').toString('base64'));
    assert.equal(result.mimeType, 'image/png');
  });
  it('незнакомое расширение → mimeType undefined', () => {
    const result = readLocalImageAsBase64('/x/a.bin', fakeReader(true));
    assert.equal(result.mimeType, undefined);
  });
  it('нет файла → понятная ошибка', () => {
    assert.throws(
      () => readLocalImageAsBase64('/x/нет.png', fakeReader(false)),
      /файл не найден: \/x\/нет\.png/,
    );
  });
});

describe('local-image — реальный nodeFileReader', () => {
  it('существующий файл читается, отсутствующий — isFile false', () => {
    const path = join(tmpdir(), `local-image-test-${process.pid}.png`);
    writeFileSync(path, 'СОДЕРЖИМОЕ');
    try {
      assert.equal(nodeFileReader.isFile(path), true);
      assert.equal(nodeFileReader.read(path).toString(), 'СОДЕРЖИМОЕ');
    } finally {
      rmSync(path, { force: true });
    }
    assert.equal(nodeFileReader.isFile(join(tmpdir(), 'нет-такого-файла-12345.png')), false);
  });
});
