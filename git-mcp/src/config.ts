import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { normalizeAllowedRepos } from './sandbox.ts';

/**
 * Корень репозитория над рабочим каталогом (вверх до `.git`); нет репозитория — сам каталог.
 *
 * Разрешать надо именно КОРЕНЬ, а не рабочий каталог: клиент запускается из своего пакета
 * (`…/ai-advent/llm-cli`), а проектом считается репозиторий (`…/ai-advent`) — он СНАРУЖИ рабочего
 * каталога, и без этого сервер требовал подтверждение на собственный проект пользователя (найдено
 * регресс-прогоном).
 */
export function workingRepositoryRoot(
  startDirectory: string,
  exists: (path: string) => boolean,
): string {
  let current = startDirectory;
  for (;;) {
    if (exists(join(current, '.git'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return startDirectory;
    }
    current = parent;
  }
}

/**
 * Кэш клонов удалённых проектов (`/project add <git URL>` в llm-cli). Всегда разрешён: репозитории
 * там создаёт сам ассистент, спрашивать по ним подтверждение бессмысленно.
 */
export function cloneCacheDir(): string {
  return join(homedir(), '.llm-cli', 'projects');
}

/**
 * Разрешённые репозитории — ОБЪЕДИНЕНИЕ источников, а не «или-или»: позиционные аргументы (ручная
 * настройка пользователя) + `GIT_ALLOWED_REPOS` (туда `llm-cli` дописывает привязанные проекты) +
 * рабочий каталог + кэш клонов.
 *
 * Именно объединение: клиент, добавляя проект, НЕ должен незаметно отбирать доступ к тому, что уже
 * работало. Рабочий каталог разрешён всегда — сервер запускается в каталоге пользователя, и это тот
 * самый проект, из которого его позвали (llm-cli и определяет его как проект по умолчанию).
 * Пустого списка не бывает: первый элемент — репозиторий по умолчанию для вызовов без `repo`.
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
  // Порядок важен: первый элемент — репозиторий ПО УМОЛЧАНИЮ (вызов без `repo`) и база для
  // относительных путей. Сначала ручная настройка пользователя, затем рабочий каталог (там и
  // запущен клиент — это «текущий» проект), и только потом проекты, добавленные автоматически:
  // иначе привязка чужого клона молча делала бы ЕГО дефолтом, и «какая ветка?» отвечало про него.
  const all = normalizeAllowedRepos([...fromArgs, workingDirectory, ...fromEnv, cloneCacheDir()]);
  return [...new Set(all)];
}

/** Потолок вывода инструмента по умолчанию: длинный diff/лог не должен съедать окно контекста. */
const DEFAULT_MAX_OUTPUT_CHARS = 8000;

/** Потолок вывода инструмента (`GIT_MAX_OUTPUT_CHARS`); невалидное/неположительное — дефолт. */
export function loadMaxOutputChars(env: NodeJS.ProcessEnv): number {
  const value = Number(env.GIT_MAX_OUTPUT_CHARS);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_MAX_OUTPUT_CHARS;
}
