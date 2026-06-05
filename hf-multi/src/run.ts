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
): Promise<void> {
  const readlineInterface = createInterface({ input, output });
  try {
    output.write(
      `Модели:\n${models.map(model => `  - ${model.id} (${model.url})`).join('\n')}\n\n`,
    );

    const override = parseModels(
      await readlineInterface.question('Сменить модели? (через запятую; Enter — оставить): '),
    );
    const targets = override.length > 0 ? toTargets(override) : models;

    const prompt = (await readlineInterface.question('Промпт: ')).trim();
    if (!prompt) {
      output.write('Промпт не указан.\n');
      return;
    }

    output.write(`\nЗапрашиваю модели параллельно (${targets.length})...\n\n`);
    const results = await generateAll(makeClient, targets, prompt, config.requestTimeoutMs);
    output.write(formatResults(results));
  } finally {
    readlineInterface.close();
  }
}
