import { stdin, stdout } from 'node:process';
import * as readline from 'node:readline/promises';
import { loadConfig, ChatCompletionClient } from '../../core/src/index.ts';
import { selectDefaultModels } from './hub.ts';
import { runMulti, parseModels } from './run.ts';
import { toTargets, fromHfModels } from './generate.ts';

/** Сколько кандидатов брать с HF Hub для отбора по числу параметров. */
const CANDIDATE_LIMIT = 60;

const config = loadConfig();
const makeClient = (modelId: string) => new ChatCompletionClient({ ...config, model: modelId });

async function main(): Promise<void> {
  // Флаг --models="a,b,c" задаёт модели вручную, иначе подбираем по параметрам.
  const flag = process.argv.slice(2).find(arg => arg.startsWith('--models='));
  const models = flag
    ? toTargets(parseModels(flag.slice('--models='.length)))
    : fromHfModels(await selectDefaultModels(CANDIDATE_LIMIT));

  await runMulti(config, models, makeClient, stdin, stdout, readline.createInterface);
}

main().catch(error => {
  console.error(`Ошибка: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
