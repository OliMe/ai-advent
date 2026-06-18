import * as readline from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import {
  loadConfig,
  ChatCompletionClient,
  FileSessionStore,
  FileProfileStore,
  FileTaskStore,
  FileRunStore,
  DEFAULT_PROFILE_NAME,
} from '../../core/src/index.ts';
import { parseArgs } from './args.ts';
import { attachFiles, combinePrompt } from './files.ts';
import { runOnce } from './chat.ts';
import { resolveSession } from './session-flow.ts';
import {
  sessionDirectory,
  profilesDirectory,
  profilePath,
  tasksDirectory,
  runsDirectory,
} from './paths.ts';
import { runInteractive, type MemorySettings } from './interactive.ts';

// Публичный API пакета собран из модулей (barrel) — тесты импортируют отсюда.
// Движок памяти переехал в core; реэкспортируем его (и прочий core) сюда же.
export * from '../../core/src/index.ts';
export * from './paths.ts';
export * from './errors.ts';
export * from './files.ts';
export * from './chat.ts';
export * from './formatters.ts';
export * from './session-flow.ts';
export * from './args.ts';
export * from './replies.ts';
export * from './run-flow.ts';
export * from './run-task-bridge.ts';
export * from './interactive.ts';

/** Точка входа: выбирает режим работы по аргументам командной строки. */
export async function main(argv: string[], input: Readable, output: Writable): Promise<void> {
  const config = loadConfig();
  const client = new ChatCompletionClient(config);

  const {
    prompt,
    limits,
    disableThinking,
    temperature: parsedTemperature,
    contextTokens: parsedContextTokens,
    stream,
    ephemeral,
    switchTo,
    branchName,
    files,
    memory,
    keepRecent,
    noMemory,
    task,
    profile,
    profileTokens,
    taskTokens,
  } = parseArgs(argv.slice(2));
  // Флаг приоритетнее переменной среды; не задан — берём из конфигурации.
  const temperature = parsedTemperature ?? config.temperature;
  const contextTokens = parsedContextTokens ?? config.contextTokens;
  const interactiveConfig = { ...config, contextTokens };

  // Содержимое --file идёт в запрос вместе с текстом промпта (режим одного запроса).
  const fullPrompt = combinePrompt(files.length > 0 ? attachFiles(files) : '', prompt);

  if (fullPrompt) {
    await runOnce(client, config, fullPrompt, limits, disableThinking, temperature, stream, output);
  } else {
    // --ephemeral — без хранилищ на диске; иначе файловые хранилища.
    const store = ephemeral ? null : new FileSessionStore(sessionDirectory());
    const session = resolveSession(store, interactiveConfig, limits, switchTo, branchName);
    // Профили (персоны): директорное хранилище + разовая миграция старого profile.json.
    const profileStore = ephemeral ? null : new FileProfileStore(profilesDirectory());
    profileStore?.migrateLegacy(profilePath());
    // Активный профиль: из --profile (и фиксируем его как активный), иначе — указатель.
    let profileName = profileStore?.activeName() ?? DEFAULT_PROFILE_NAME;
    if (profile !== undefined) {
      profileName = profile;
      profileStore?.setActive(profile);
    }
    // Слоистая память включена по умолчанию; --ephemeral держит её в памяти.
    const memorySettings: MemorySettings = {
      enabled: !noMemory,
      profileStore,
      taskStore: ephemeral ? null : new FileTaskStore(tasksDirectory()),
      profileTokens,
      taskTokens,
      initialTaskTitle: task,
      profileName,
    };
    // Хранилище прогонов задач (пайплайн); --ephemeral держит прогон только в памяти.
    const runStore = ephemeral ? null : new FileRunStore(runsDirectory());
    await runInteractive(
      client,
      interactiveConfig,
      limits,
      disableThinking,
      temperature,
      stream,
      memory,
      keepRecent,
      session,
      store,
      input,
      output,
      readline.createInterface,
      memorySettings,
      runStore,
    );
  }
}
