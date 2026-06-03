import { createWriteStream } from 'node:fs';
import { stdout } from 'node:process';
import { loadConfig, ChatCompletionClient } from '../../core/src/index.ts';
import { parseGenerateArgs, runGenerate } from './generate-list.ts';

const options = parseGenerateArgs(process.argv.slice(2));
// Модель генератора задаётся флагом --model (по умолчанию быстрая), а не LLM_MODEL.
const config = { ...loadConfig(), model: options.model };
const client = new ChatCompletionClient(config);
const output = options.out ? createWriteStream(options.out) : stdout;

runGenerate(options, client, config.requestTimeoutMs, output)
  .then(() => {
    if (options.out) output.end();
  })
  .catch(error => {
    console.error(`Ошибка: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
