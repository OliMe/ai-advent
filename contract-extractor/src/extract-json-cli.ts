import { stdout } from 'node:process';
import { loadConfig, ChatCompletionClient } from '../../core/src/index.ts';
import { runExtractJson } from './extract-json.ts';

const config = loadConfig();
const client = new ChatCompletionClient(config);

runExtractJson(process.argv, client, config, stdout).catch(error => {
  console.error(`Ошибка: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
