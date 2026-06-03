import { readFileSync } from 'node:fs';
import type { Writable } from 'node:stream';
import type { AppConfig, ChatCompletionClient } from '../../core/src/index.ts';
import { DEFAULT_SEPARATOR, splitContracts, batch } from './contracts.ts';
import { listBatch } from './extract.ts';

const DEFAULT_BATCH_SIZE = 5;

/** Разделитель между договорами в человекочитаемом выводе. */
const SEPARATOR_LINE = '─'.repeat(60);

/** Опции свободного режима, собранные из аргументов. */
export interface ListOptions {
  file: string;
  batchSize: number;
  separator: string;
}

/** Разбирает значение флага как положительное целое. */
function positiveInt(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} требует положительное целое, получено: ${value}`);
  }
  return parsed;
}

/**
 * Разбирает аргументы свободного режима: путь к файлу (позиционный) и флаги
 * `--batch`, `--separator`.
 */
export function parseListArgs(args: string[]): ListOptions {
  let file: string | undefined;
  let batchSize = DEFAULT_BATCH_SIZE;
  let separator = DEFAULT_SEPARATOR;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      file = arg;
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const value = eq === -1 ? args[++i] : arg.slice(eq + 1);
    if (value === undefined) {
      throw new Error(`Не указано значение для ${name}`);
    }

    if (name === '--batch') {
      batchSize = positiveInt(name, value);
    } else if (name === '--separator') {
      separator = value;
    } else {
      throw new Error(`Неизвестный флаг: ${name}`);
    }
  }

  if (file === undefined) {
    throw new Error('Не указан путь к файлу с договорами');
  }
  return { file, batchSize, separator };
}

/**
 * Свободный режим: без ограничений формата печатает реквизиты сторон договоров
 * человекочитаемым текстовым списком с разделителем между договорами.
 */
export async function runListText(
  argv: string[],
  client: ChatCompletionClient,
  config: AppConfig,
  output: Writable,
): Promise<void> {
  const options = parseListArgs(argv.slice(2));
  const text = readFileSync(options.file, 'utf8');
  const contracts = splitContracts(text, options.separator);

  const blocks: string[] = [];
  for (const group of batch(contracts, options.batchSize)) {
    blocks.push(...(await listBatch(client, group, config.requestTimeoutMs)));
  }

  output.write(blocks.join(`\n\n${SEPARATOR_LINE}\n\n`) + '\n');
}
