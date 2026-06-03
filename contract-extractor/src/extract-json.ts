import { readFileSync } from 'node:fs';
import type { Writable } from 'node:stream';
import type { AppConfig, ChatCompletionClient } from '../../core/src/index.ts';
import { DEFAULT_SEPARATOR, splitContracts, batch } from './contracts.ts';
import { extractBatch } from './extract.ts';
import type { ContractParties } from './parties.ts';

const DEFAULT_BATCH_SIZE = 5;
const DEFAULT_MAX_TOKENS = 1500;

/** Опции строгого режима, собранные из аргументов. */
export interface ExtractOptions {
  file: string;
  limit?: number;
  batchSize: number;
  separator: string;
  maxTokens: number;
  /** Отключить «рассуждения» модели — быстрее/дешевле и не съедает лимит токенов. */
  noThinking: boolean;
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
 * Разбирает аргументы строгого режима: путь к файлу (позиционный) и флаги
 * `--limit`, `--batch`, `--separator`, `--max-tokens`, `--no-thinking`.
 */
export function parseExtractArgs(args: string[]): ExtractOptions {
  let file: string | undefined;
  let limit: number | undefined;
  let batchSize = DEFAULT_BATCH_SIZE;
  let separator = DEFAULT_SEPARATOR;
  let maxTokens = DEFAULT_MAX_TOKENS;
  let noThinking = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      file = arg;
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (name === '--no-thinking') {
      noThinking = true;
      continue;
    }
    const value = eq === -1 ? args[++i] : arg.slice(eq + 1);
    if (value === undefined) {
      throw new Error(`Не указано значение для ${name}`);
    }

    if (name === '--limit') {
      limit = positiveInt(name, value);
    } else if (name === '--batch') {
      batchSize = positiveInt(name, value);
    } else if (name === '--separator') {
      separator = value;
    } else if (name === '--max-tokens') {
      maxTokens = positiveInt(name, value);
    } else {
      throw new Error(`Неизвестный флаг: ${name}`);
    }
  }

  if (file === undefined) {
    throw new Error('Не указан путь к файлу с договорами');
  }
  return { file, limit, batchSize, separator, maxTokens, noThinking };
}

/**
 * Строгий режим: извлекает реквизиты сторон по всем договорам и печатает массив
 * объектов JSON. При лимите N обрабатывает договоры пакетами, просит модель
 * вернуть только нужное число объектов и прекращает слать пакеты, как только
 * набрано N — это экономит и входные, и выходные токены.
 */
export async function runExtractJson(
  argv: string[],
  client: ChatCompletionClient,
  config: AppConfig,
  output: Writable,
): Promise<void> {
  const options = parseExtractArgs(argv.slice(2));
  const text = readFileSync(options.file, 'utf8');
  const contracts = splitContracts(text, options.separator);
  const target = options.limit ?? contracts.length;

  const collected: ContractParties[] = [];
  for (const group of batch(contracts, options.batchSize)) {
    const need = target - collected.length;
    if (need <= 0) break;
    const wantCount = Math.min(need, group.length);
    const results = await extractBatch(
      client,
      group,
      wantCount,
      options.maxTokens,
      config.requestTimeoutMs,
      options.noThinking,
    );
    collected.push(...results.slice(0, need));
  }

  output.write(JSON.stringify(collected.slice(0, target), null, 2) + '\n');
}
