import type { Writable } from 'node:stream';
import type { ChatCompletionClient } from '../../core/src/index.ts';
import { generateOne, generateBatch } from './generate.ts';

/** Разделитель договоров в выходном файле (совместим с contract-extractor). */
export const OUTPUT_SEPARATOR = '=====';

const DEFAULT_COUNT = 10;
const DEFAULT_MAX_TOKENS = 600;
// Параллельность ограничена 2: z.ai режет одновременные запросы rate-лимитом.
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_PER_REQUEST = 1;

/**
 * Модель по умолчанию: быстрая и дешёвая. Главное — вместе с отключёнными
 * рассуждениями она не тратит токены на reasoning и корректно реагирует на
 * стоп-маркер (reasoning-модель вроде glm-5.1 для генерации здесь избыточна).
 */
export const DEFAULT_MODEL = 'glm-4.5-flash';

/** Опции генератора, собранные из аргументов. */
export interface GenerateOptions {
  count: number;
  maxTokens: number;
  concurrency: number;
  /** Сколько договоров просить за один запрос: 1 — режим стоп-маркера, >1 — пакетный. */
  perRequest: number;
  model: string;
  out?: string;
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
 * Разбирает аргументы: `--count`, `--per-request`, `--max-tokens`,
 * `--concurrency`, `--model`, `--out`. Позиционных аргументов нет.
 */
export function parseGenerateArgs(args: string[]): GenerateOptions {
  let count = DEFAULT_COUNT;
  let maxTokens = DEFAULT_MAX_TOKENS;
  let concurrency = DEFAULT_CONCURRENCY;
  let perRequest = DEFAULT_PER_REQUEST;
  let model = DEFAULT_MODEL;
  let out: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const value = eq === -1 ? args[++i] : arg.slice(eq + 1);
    if (value === undefined) {
      throw new Error(`Не указано значение для ${name}`);
    }

    if (name === '--count') {
      count = positiveInt(name, value);
    } else if (name === '--per-request') {
      perRequest = positiveInt(name, value);
    } else if (name === '--max-tokens') {
      maxTokens = positiveInt(name, value);
    } else if (name === '--concurrency') {
      concurrency = positiveInt(name, value);
    } else if (name === '--model') {
      model = value;
    } else if (name === '--out') {
      out = value;
    } else {
      throw new Error(`Неизвестный флаг: ${name}`);
    }
  }

  return { count, maxTokens, concurrency, perRequest, model, out };
}

/** Описание одного запроса: с какого порядкового номера и сколько договоров. */
interface Chunk {
  seedBase: number;
  size: number;
}

/** Разбивает `count` договоров на запросы по `perRequest` штук. */
function planChunks(count: number, perRequest: number): Chunk[] {
  const chunks: Chunk[] = [];
  for (let start = 0; start < count; start += perRequest) {
    chunks.push({ seedBase: start + 1, size: Math.min(perRequest, count - start) });
  }
  return chunks;
}

/**
 * Генерирует `count` договоров пулом не более `concurrency` одновременных
 * запросов; результаты сохраняют исходный порядок. При `perRequest === 1`
 * работает режим стоп-маркера (по договору на запрос), иначе — пакетный.
 */
export async function generateMany(
  client: ChatCompletionClient,
  count: number,
  perRequest: number,
  maxTokens: number,
  concurrency: number,
  requestTimeoutMs: number,
): Promise<string[]> {
  const chunks = planChunks(count, perRequest);
  const perChunk: string[][] = new Array(chunks.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < chunks.length) {
      const index = nextIndex++;
      const { seedBase, size } = chunks[index];
      perChunk[index] =
        perRequest === 1
          ? [await generateOne(client, seedBase, maxTokens, requestTimeoutMs)]
          : await generateBatch(client, size, seedBase, maxTokens, requestTimeoutMs);
    }
  }

  const workerCount = Math.min(concurrency, chunks.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  // Пакетный режим может вернуть больше нужного — фиксируем не более count.
  return perChunk.flat().slice(0, count);
}

/** Генерирует список договоров и пишет его в вывод через разделитель. */
export async function runGenerate(
  options: GenerateOptions,
  client: ChatCompletionClient,
  requestTimeoutMs: number,
  output: Writable,
): Promise<void> {
  const contracts = await generateMany(
    client,
    options.count,
    options.perRequest,
    options.maxTokens,
    options.concurrency,
    requestTimeoutMs,
  );
  output.write(contracts.join(`\n${OUTPUT_SEPARATOR}\n`) + '\n');
}
