import * as readline from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import type { AppConfig } from '../../core/src/index.ts';
import {
  type TargetModel,
  type ClientFactory,
  generateAll,
  formatResults,
  toTargets,
} from './generate.ts';

/** Разбирает список моделей из строки «через запятую». */
export function parseModels(raw: string): string[] {
  return raw
    .split(',')
    .map(id => id.trim())
    .filter(id => id.length > 0);
}

/**
 * Разбирает значение --max-tokens: положительное целое или undefined (флаг не
 * задан либо значение некорректно — тогда берётся дефолтный потолок).
 */
export function parseMaxTokens(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/** Строка со списком выбранных моделей и ссылками на них. */
function listModels(models: TargetModel[]): string {
  return `Модели:\n${models.map(model => `  - ${model.id} (${model.url})`).join('\n')}\n\n`;
}

/** Запрашивает модели параллельно и печатает их ответы (общая часть сценариев). */
async function reportAnswers(
  config: AppConfig,
  models: TargetModel[],
  makeClient: ClientFactory,
  output: Writable,
  prompt: string,
  maxTokens: number | undefined,
): Promise<void> {
  output.write(`\nЗапрашиваю модели параллельно (${models.length})...\n\n`);
  const results = await generateAll(makeClient, models, prompt, config.requestTimeoutMs, maxTokens);
  output.write(formatResults(results));
}

/**
 * Неинтерактивный сценарий: промпт задан заранее (флагом `--prompt`), ничего не
 * спрашиваем — сразу показываем модели, запрашиваем их и печатаем ответы.
 */
export async function runOnce(
  config: AppConfig,
  models: TargetModel[],
  makeClient: ClientFactory,
  output: Writable,
  prompt: string,
  maxTokens?: number,
): Promise<void> {
  output.write(listModels(models));
  await reportAnswers(config, models, makeClient, output, prompt, maxTokens);
}

/**
 * Интерактивный сценарий: показывает выбранные модели (их можно сменить),
 * спрашивает промпт, запрашивает все модели параллельно и печатает ответы
 * с обозначением модели и ссылкой на HuggingFace.
 */
export async function runMulti(
  config: AppConfig,
  models: TargetModel[],
  makeClient: ClientFactory,
  input: Readable,
  output: Writable,
  // Передаётся явно — это же даёт тестам шов для подмены интерфейса.
  createInterface: typeof readline.createInterface,
  maxTokens?: number,
): Promise<void> {
  const readlineInterface = createInterface({ input, output });
  try {
    output.write(listModels(models));

    const override = parseModels(
      await readlineInterface.question('Сменить модели? (через запятую; Enter — оставить): '),
    );
    const targets = override.length > 0 ? toTargets(override) : models;

    const prompt = (await readlineInterface.question('Промпт: ')).trim();
    if (!prompt) {
      output.write('Промпт не указан.\n');
      return;
    }

    await reportAnswers(config, targets, makeClient, output, prompt, maxTokens);
  } finally {
    readlineInterface.close();
  }
}
