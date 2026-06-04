import { stdin, stdout } from 'node:process';
import * as readline from 'node:readline/promises';
import { loadConfig, ChatCompletionClient } from '../../core/src/index.ts';
import { runSolve } from './run.ts';

const config = loadConfig();
const client = new ChatCompletionClient(config);

runSolve(client, config, stdin, stdout, readline.createInterface).catch(error => {
  console.error(`Ошибка: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
