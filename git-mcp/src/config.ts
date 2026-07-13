import { homedir } from 'node:os';
import { join } from 'node:path';
import { normalizeAllowedRepos } from './sandbox.ts';

/**
 * Кэш клонов удалённых проектов (`/project add <git URL>` в llm-cli). Всегда разрешён: репозитории
 * там создаёт сам ассистент, спрашивать по ним подтверждение бессмысленно.
 */
export function cloneCacheDir(): string {
  return join(homedir(), '.llm-cli', 'projects');
}

/**
 * Разрешённые репозитории: позиционные аргументы, иначе `GIT_ALLOWED_REPOS` (через запятую), иначе
 * текущий каталог. К списку всегда добавляется кэш клонов. Пустого списка не бывает — первый
 * элемент служит репозиторием по умолчанию для инструментов без аргумента `repo`.
 */
export function loadAllowedRepos(
  args: string[],
  env: NodeJS.ProcessEnv,
  workingDirectory: string,
): string[] {
  const fromArgs = args.map(value => value.trim()).filter(Boolean);
  const fromEnv = (env.GIT_ALLOWED_REPOS ?? '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  const explicit = fromArgs.length > 0 ? fromArgs : fromEnv;
  const repos = explicit.length > 0 ? explicit : [workingDirectory];
  return normalizeAllowedRepos([...repos, cloneCacheDir()]);
}

/** Потолок вывода инструмента по умолчанию: длинный diff/лог не должен съедать окно контекста. */
const DEFAULT_MAX_OUTPUT_CHARS = 8000;

/** Потолок вывода инструмента (`GIT_MAX_OUTPUT_CHARS`); невалидное/неположительное — дефолт. */
export function loadMaxOutputChars(env: NodeJS.ProcessEnv): number {
  const value = Number(env.GIT_MAX_OUTPUT_CHARS);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_MAX_OUTPUT_CHARS;
}
