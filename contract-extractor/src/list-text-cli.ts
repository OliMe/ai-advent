import { stdout } from 'node:process';
import { loadConfig, ChatCompletionClient } from '../../core/src/index.ts';
import { runListText } from './list-text.ts';

const config = loadConfig();
const client = new ChatCompletionClient(config);

runListText(process.argv, client, config, stdout).catch(error => {
  console.error(`Ошибка: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
