import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import type { CommandRunner } from './clipboard-image.ts';

/**
 * Запуск git для привязки проекта. `GIT_TERMINAL_PROMPT=0` обязателен: без него git на приватном или
 * несуществующем репозитории ЖДЁТ ввод логина/пароля — в интерактивном CLI это выглядит как зависание
 * (пользователь не видит, кто и что у него спрашивает). С запретом промпта git сразу возвращает
 * ошибку, и мы показываем её текстом.
 */
export const realGitRunner: CommandRunner = (command, args) =>
  execFileSync(command, args, {
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });

/**
 * Похож ли аргумент на удалённый репозиторий: `https://…`, `git@host:owner/repo`, `ssh://…` или
 * путь с суффиксом `.git`. Иначе — локальный путь.
 */
export function isRepositoryUrl(input: string): boolean {
  return (
    /^(https?|git|ssh):\/\//i.test(input) ||
    /^[\w.-]+@[\w.-]+:/.test(input) ||
    /\.git\/?$/i.test(input)
  );
}

/** Каталог кэша клонов удалённых проектов (он же всегда разрешён в git-mcp). */
export function projectsCacheDirectory(): string {
  return join(homedir(), '.llm-cli', 'projects');
}

/**
 * Куда клонировать URL: `<кэш>/<хэш URL>/<имя репозитория>`. Хэш — отдельным каталогом, а не
 * суффиксом имени: имя проекта берётся из имени каталога (`basename`), и «is-odd» должен остаться
 * «is-odd», а не стать «is-odd-2117368d» — этим именем пользователь адресует проект. Хэш при этом
 * разводит одноимённые репозитории с разных хостов (форки). Считается от НОРМАЛИЗОВАННОГО URL (без
 * хвостового слэша и `.git`): один репозиторий в разной записи — один клон, а не копии.
 */
export function cloneTargetDirectory(url: string): string {
  const cleaned = url.replace(/\/+$/, '').replace(/\.git$/i, '');
  const name = basename(cleaned) || 'repo';
  const hash = createHash('sha1').update(cleaned).digest('hex').slice(0, 8);
  return join(projectsCacheDirectory(), hash, name);
}

/** Зависимости привязки проекта: запуск git, проверка существования пути, отчёт о прогрессе. */
export interface ProjectSourceDeps {
  runner: CommandRunner;
  exists: (path: string) => boolean;
  onProgress?: (message: string) => void;
}

/** Текст ошибки из неизвестного значения. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Разворачивает `~` и приводит локальный путь к абсолютному. */
function localPath(input: string): string {
  const expanded = input === '~' ? homedir() : input.replace(/^~\//, `${homedir()}/`);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(process.cwd(), expanded);
}

/**
 * Сводит источник проекта к ЛОКАЛЬНОМУ корню: путь берётся как есть, а удалённый репозиторий
 * клонируется в кэш (повторная привязка — `fetch`, а не новый клон). Так дальше весь ассистент
 * (git-инструменты, документация, пайплайн) работает с любым проектом единообразно.
 *
 * Клон `--filter=blob:none`, а НЕ `--depth=1`: неполная история сделала бы `git log`/`git diff`
 * бесполезными, а именно ими ассистент понимает проект. Blobless-клон отдаёт всю историю, а
 * содержимое файлов подтягивает по мере обращения.
 */
export function resolveProjectRoot(input: string, deps: ProjectSourceDeps): string {
  if (!isRepositoryUrl(input)) {
    const path = localPath(input);
    if (!deps.exists(path)) {
      throw new Error(`Каталог не найден: ${path}`);
    }
    return path;
  }
  const target = cloneTargetDirectory(input);
  if (deps.exists(join(target, '.git'))) {
    deps.onProgress?.(`Проект уже склонирован, обновляю: ${target}`);
    try {
      deps.runner('git', ['-C', target, 'fetch', '--prune']);
    } catch (error) {
      // Обновление — не критично: работать можно и с ранее склонированной копией.
      deps.onProgress?.(`Не удалось обновить клон (работаю с текущей копией): ${errorText(error)}`);
    }
    return target;
  }
  deps.onProgress?.(`Клонирую ${input} → ${target} …`);
  try {
    deps.runner('git', ['clone', '--filter=blob:none', input, target]);
  } catch (error) {
    throw new Error(`Не удалось клонировать ${input}: ${errorText(error)}`);
  }
  return target;
}
