import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseListArgs, runListText } from '../list-text.ts';
import { makeClient, makeCollector, makeConfig } from './helpers.ts';

describe('parseListArgs', () => {
  it('возвращает значения по умолчанию при одном файле', () => {
    const options = parseListArgs(['contracts.txt']);
    assert.equal(options.file, 'contracts.txt');
    assert.equal(options.batchSize, 5);
    assert.equal(options.separator, '=====');
  });

  it('читает флаги (форма = и пробел)', () => {
    const options = parseListArgs(['f.txt', '--batch', '2', '--separator=###']);
    assert.equal(options.batchSize, 2);
    assert.equal(options.separator, '###');
  });

  it('бросает ошибку при невалидном --batch', () => {
    assert.throws(() => parseListArgs(['f.txt', '--batch=0']), /положительное целое/);
  });

  it('бросает ошибку, если у флага нет значения', () => {
    assert.throws(() => parseListArgs(['f.txt', '--batch']), /Не указано значение/);
  });

  it('бросает ошибку на неизвестном флаге', () => {
    assert.throws(() => parseListArgs(['f.txt', '--oops=1']), /Неизвестный флаг/);
  });

  it('бросает ошибку, если файл не указан', () => {
    assert.throws(() => parseListArgs(['--batch=2']), /Не указан путь к файлу/);
  });
});

describe('runListText', () => {
  it('печатает блоки реквизитов с разделителем между ними', async t => {
    const client = makeClient(t, async () => 'Блок A<<<NEXT>>>Блок B');
    const output = makeCollector();

    const dir = mkdtempSync(join(tmpdir(), 'list-'));
    const file = join(dir, 'contracts.txt');
    writeFileSync(file, 'Договор 1\n=====\nДоговор 2');
    try {
      await runListText(['node', 'cli', file], client, makeConfig(), output.stream);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    const text = output.text();
    assert.match(text, /Блок A/);
    assert.match(text, /Блок B/);
    assert.match(text, /─{10,}/);
  });
});
