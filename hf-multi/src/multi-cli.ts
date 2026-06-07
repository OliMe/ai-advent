import { stdin, stdout } from 'node:process';
import * as readline from 'node:readline/promises';
import { loadConfig, ChatCompletionClient } from '../../core/src/index.ts';
import { selectDefaultModels } from './hub.ts';
import { runMulti, runOnce, parseModels } from './run.ts';
import { toTargets, fromHfModels } from './generate.ts';

/** Сколько кандидатов брать с HF Hub для отбора по числу параметров. */
const CANDIDATE_LIMIT = 60;

const config = loadConfig();
const makeClient = (modelId: string) => new ChatCompletionClient({ ...config, model: modelId });

/** Значение аргумента вида `--name=value`, либо undefined, если флага нет. */
function flagValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const argument = process.argv.slice(2).find(arg => arg.startsWith(prefix));
  return argument?.slice(prefix.length);
}

async function main(): Promise<void> {
  // Флаг --models="a,b,c" задаёт модели вручную, иначе подбираем по параметрам.
  const modelsFlag = flagValue('models');
  const models = modelsFlag
    ? toTargets(parseModels(modelsFlag))
    : fromHfModels(await selectDefaultModels(CANDIDATE_LIMIT));

  // Флаг --prompt="…" запускает неинтерактивный режим: ничего не спрашиваем.
  const prompt = flagValue('prompt')?.trim();
  if (prompt) {
    await runOnce(config, models, makeClient, stdout, prompt);
    return;
  }

  await runMulti(config, models, makeClient, stdin, stdout, readline.createInterface);
}

main().catch(error => {
  console.error(`Ошибка: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
