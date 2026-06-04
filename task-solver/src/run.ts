import * as readline from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import type { AppConfig, ChatCompletionClient } from '../../core/src/index.ts';
import { parseExperts, solveAll, formatResult } from './solve.ts';

/**
 * Интерактивный сценарий: спрашивает задачу и состав экспертов, решает её
 * четырьмя способами и печатает все решения с итоговой оценкой GLM.
 */
export async function runSolve(
  client: ChatCompletionClient,
  config: AppConfig,
  input: Readable,
  output: Writable,
  // Передаётся явно — это же даёт тестам шов для подмены интерфейса.
  createInterface: typeof readline.createInterface,
): Promise<void> {
  const readlineInterface = createInterface({ input, output });
  try {
    const task = (await readlineInterface.question('Задача: ')).trim();
    if (!task) {
      output.write('Задача не указана — нечего решать.\n');
      return;
    }

    const experts = parseExperts(await readlineInterface.question('Эксперты (через запятую): '));

    output.write('\nРешаю четырьмя способами и оцениваю результат...\n\n');
    const result = await solveAll(client, task, experts, config.requestTimeoutMs);
    output.write(formatResult(result));
  } finally {
    readlineInterface.close();
  }
}
