import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatCompletionClient } from '../../../core/src/index.ts';
import { parseExtractArgs, runExtractJson } from '../extract-json.ts';
import { makeClient, makeCollector, makeConfig } from './helpers.ts';

/** Ответ модели с n объектами договоров. */
function response(n: number): string {
  const items = Array.from({ length: n }, (_, i) => ({
    landlord: { name: `L${i}` },
    tenant: { name: `T${i}` },
  }));
  return JSON.stringify({ contracts: items });
}

/** Создаёт временный файл с договорами, разделёнными `=====`. */
function withContractsFile(
  contracts: string[],
  run: (file: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'extract-'));
  const file = join(dir, 'contracts.txt');
  writeFileSync(file, contracts.join('\n=====\n'));
  return run(file).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe('parseExtractArgs', () => {
  it('возвращает значения по умолчанию при одном файле', () => {
    const options = parseExtractArgs(['contracts.txt']);
    assert.equal(options.file, 'contracts.txt');
    assert.equal(options.limit, undefined);
    assert.equal(options.batchSize, 5);
    assert.equal(options.separator, '=====');
    assert.equal(options.maxTokens, 1500);
    assert.equal(options.noThinking, false);
  });

  it('читает все флаги (форма = и пробел), включая --no-thinking', () => {
    const options = parseExtractArgs([
      'f.txt',
      '--limit=2',
      '--batch',
      '3',
      '--separator=###',
      '--max-tokens=900',
      '--no-thinking',
    ]);
    assert.equal(options.limit, 2);
    assert.equal(options.batchSize, 3);
    assert.equal(options.separator, '###');
    assert.equal(options.maxTokens, 900);
    assert.equal(options.noThinking, true);
  });

  it('бросает ошибку при невалидном числовом флаге', () => {
    assert.throws(() => parseExtractArgs(['f.txt', '--limit=0']), /положительное целое/);
  });

  it('бросает ошибку, если у флага нет значения', () => {
    assert.throws(() => parseExtractArgs(['f.txt', '--limit']), /Не указано значение/);
  });

  it('бросает ошибку на неизвестном флаге', () => {
    assert.throws(() => parseExtractArgs(['f.txt', '--oops=1']), /Неизвестный флаг/);
  });

  it('бросает ошибку, если файл не указан', () => {
    assert.throws(() => parseExtractArgs(['--limit=1']), /Не указан путь к файлу/);
  });
});

describe('runExtractJson', () => {
  it('без лимита извлекает все договоры в JSON-массив', async t => {
    const client = makeClient(t, async () => response(2));
    const output = makeCollector();

    await withContractsFile(['Договор 1', 'Договор 2'], async file => {
      await runExtractJson(['node', 'cli', file], client, makeConfig(), output.stream);
    });

    const parsed = JSON.parse(output.text());
    assert.equal(parsed.length, 2);
  });

  it('с лимитом N прекращает слать пакеты, как только набрано N', async t => {
    let calls = 0;
    const client = makeClient(t, async () => {
      calls++;
      return response(1);
    });
    const output = makeCollector();

    await withContractsFile(['Д1', 'Д2', 'Д3'], async file => {
      await runExtractJson(
        ['node', 'cli', file, '--limit=1', '--batch=1'],
        client,
        makeConfig(),
        output.stream,
      );
    });

    const parsed = JSON.parse(output.text());
    assert.equal(parsed.length, 1);
    assert.equal(calls, 1); // второй и третий пакеты не отправлены
  });

  it('--no-thinking отключает рассуждения в запросе', async t => {
    let capturedOptions: Parameters<ChatCompletionClient['complete']>[1];
    const client = makeClient(t, async (_messages, options) => {
      capturedOptions = options;
      return response(1);
    });
    const output = makeCollector();

    await withContractsFile(['Договор 1'], async file => {
      await runExtractJson(
        ['node', 'cli', file, '--no-thinking'],
        client,
        makeConfig(),
        output.stream,
      );
    });

    assert.equal(capturedOptions?.disableThinking, true);
  });
});
