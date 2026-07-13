import { classifyPath, resolveInsideRepo } from './sandbox.ts';
import type { GitIo } from './operations.ts';

/**
 * Зависимости обработчиков: операции над репозиторием, allow-list, потолок вывода и (опционально)
 * запрос подтверждения для репозитория вне allow-list. Без `confirm` такой репозиторий отклоняется
 * (жёсткая песочница); с `confirm` — у пользователя спрашивают разрешение (MCP elicitation), чтобы
 * ассистент мог работать с любым проектом без правки конфигурации сервера.
 */
export interface ToolDeps {
  io: GitIo;
  allowedRepos: string[];
  maxOutputChars: number;
  confirm?: (message: string) => Promise<boolean>;
}

/** Решение ворот доступа: корень разрешённого репозитория или текст отказа. */
type Gate = { root: string } | { refusal: string };

/** Непустая строка из аргумента или null. */
function stringArg(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** Целое из аргумента в границах [minimum, maximum] или значение по умолчанию. */
function boundedNumberArg(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(Math.floor(parsed), minimum), maximum);
}

/** Максимум коммитов в одном ответе `git_log`. */
const MAX_LOG_LIMIT = 50;

/** Коммитов в `git_log` по умолчанию. */
const DEFAULT_LOG_LIMIT = 10;

/** Обрезает длинный вывод, честно помечая усечение (иначе модель примет обрывок за целое). */
export function limitOutput(text: string, maxChars: number): string {
  return text.length <= maxChars
    ? text
    : `${text.slice(0, maxChars)}\n… (вывод усечён: ${text.length} символов, показано ${maxChars})`;
}

/**
 * Ворота доступа к репозиторию: путь из `repo` (или первый разрешённый), внутри allow-list —
 * пропускаем; вне — спрашиваем подтверждение, если оно доступно. Затем проверяем, что это вообще
 * git-репозиторий, и возвращаем его КОРЕНЬ (`rev-parse --show-toplevel`) — так путь к подкаталогу
 * репозитория тоже работает.
 */
async function authorizeRepository(deps: ToolDeps, args: Record<string, unknown>): Promise<Gate> {
  const input = stringArg(args.repo) ?? deps.allowedRepos[0];
  const { absolute, withinAllowed } = classifyPath(input, deps.allowedRepos);
  if (!withinAllowed) {
    if (deps.confirm === undefined) {
      return { refusal: `Репозиторий вне разрешённых: ${input}` };
    }
    const approved = await deps.confirm(
      `Репозиторий «${absolute}» вне разрешённых каталогов. Разрешить чтение из него?`,
    );
    if (!approved) {
      return { refusal: `Чтение репозитория вне песочницы отклонено пользователем: ${input}` };
    }
  }
  const result = deps.io.run(['rev-parse', '--show-toplevel'], absolute);
  if (!result.ok) {
    return { refusal: `Не git-репозиторий: ${absolute}` };
  }
  return { root: result.output.trim() };
}

/**
 * Запускает git и приводит ответ к тексту: ненулевой код с пустым выводом — это «пусто» (например
 * `git grep` без совпадений), с текстом — ошибка; успех с пустым выводом — тоже «пусто».
 */
function gitText(deps: ToolDeps, root: string, args: string[], emptyMessage: string): string {
  const result = deps.io.run(args, root);
  const output = result.output.trim();
  if (!result.ok) {
    return output === '' ? emptyMessage : `Ошибка git: ${output}`;
  }
  return output === '' ? emptyMessage : limitOutput(output, deps.maxOutputChars);
}

/** Путь внутри репозитория из аргумента: null — аргумента нет, refusal — выход за пределы репо. */
function insideRepoArg(
  root: string,
  value: unknown,
): { path: string } | { refusal: string } | null {
  const input = stringArg(value);
  if (input === null) {
    return null;
  }
  const absolute = resolveInsideRepo(root, input);
  return absolute === null ? { refusal: `Путь вне репозитория: ${input}` } : { path: absolute };
}

/** Текущая ветка репозитория (или отделённый HEAD). */
export async function handleGitBranch(
  deps: ToolDeps,
  args: Record<string, unknown>,
): Promise<string> {
  const gate = await authorizeRepository(deps, args);
  if ('refusal' in gate) {
    return gate.refusal;
  }
  const branch = deps.io.run(['rev-parse', '--abbrev-ref', 'HEAD'], gate.root);
  if (!branch.ok) {
    return `Ошибка git: ${branch.output.trim()}`;
  }
  const name = branch.output.trim();
  if (name !== 'HEAD') {
    return `Репозиторий: ${gate.root}\nВетка: ${name}`;
  }
  const commit = deps.io.run(['rev-parse', '--short', 'HEAD'], gate.root);
  return `Репозиторий: ${gate.root}\nВетка: HEAD отделён (${commit.output.trim()})`;
}

/** Изменённые и неотслеживаемые файлы (короткий статус). */
export async function handleGitStatus(
  deps: ToolDeps,
  args: Record<string, unknown>,
): Promise<string> {
  const gate = await authorizeRepository(deps, args);
  if ('refusal' in gate) {
    return gate.refusal;
  }
  return gitText(deps, gate.root, ['status', '--short'], 'Рабочее дерево чисто: изменений нет.');
}

/** Отслеживаемые файлы репозитория (опционально — только внутри подкаталога). */
export async function handleGitListFiles(
  deps: ToolDeps,
  args: Record<string, unknown>,
): Promise<string> {
  const gate = await authorizeRepository(deps, args);
  if ('refusal' in gate) {
    return gate.refusal;
  }
  const subdirectory = insideRepoArg(gate.root, args.subdir);
  if (subdirectory !== null && 'refusal' in subdirectory) {
    return subdirectory.refusal;
  }
  const command = subdirectory === null ? ['ls-files'] : ['ls-files', '--', subdirectory.path];
  return gitText(deps, gate.root, command, 'Отслеживаемых файлов не найдено.');
}

/** Последние коммиты (хэш, дата, автор, заголовок). */
export async function handleGitLog(deps: ToolDeps, args: Record<string, unknown>): Promise<string> {
  const gate = await authorizeRepository(deps, args);
  if ('refusal' in gate) {
    return gate.refusal;
  }
  const limit = boundedNumberArg(args.limit, DEFAULT_LOG_LIMIT, 1, MAX_LOG_LIMIT);
  const command = ['log', '-n', String(limit), '--date=short', '--pretty=format:%h %ad %an — %s'];
  return gitText(deps, gate.root, command, 'История пуста.');
}

/** Незакоммиченные изменения (по умолчанию — рабочее дерево; `staged` — индекс). */
export async function handleGitDiff(
  deps: ToolDeps,
  args: Record<string, unknown>,
): Promise<string> {
  const gate = await authorizeRepository(deps, args);
  if ('refusal' in gate) {
    return gate.refusal;
  }
  const file = insideRepoArg(gate.root, args.path);
  if (file !== null && 'refusal' in file) {
    return file.refusal;
  }
  const command = ['diff'];
  if (args.staged === true) {
    command.push('--cached');
  }
  if (file !== null) {
    command.push('--', file.path);
  }
  return gitText(deps, gate.root, command, 'Изменений нет.');
}

/** Точный поиск по отслеживаемым файлам (`git grep`) — дополняет векторный поиск по документации. */
export async function handleGitGrep(
  deps: ToolDeps,
  args: Record<string, unknown>,
): Promise<string> {
  const pattern = stringArg(args.pattern);
  if (pattern === null) {
    return 'Нужен непустой pattern.';
  }
  const gate = await authorizeRepository(deps, args);
  if ('refusal' in gate) {
    return gate.refusal;
  }
  const subdirectory = insideRepoArg(gate.root, args.subdir);
  if (subdirectory !== null && 'refusal' in subdirectory) {
    return subdirectory.refusal;
  }
  // -e перед шаблоном: шаблон, начинающийся с дефиса, не будет принят за флаг.
  const command = ['grep', '-n', '-I', '--no-color', '-e', pattern];
  if (subdirectory !== null) {
    command.push('--', subdirectory.path);
  }
  return gitText(deps, gate.root, command, 'Совпадений не найдено.');
}

/** Читает файл рабочего дерева репозитория. */
export async function handleReadFile(
  deps: ToolDeps,
  args: Record<string, unknown>,
): Promise<string> {
  const gate = await authorizeRepository(deps, args);
  if ('refusal' in gate) {
    return gate.refusal;
  }
  const file = insideRepoArg(gate.root, args.path);
  if (file === null) {
    return 'Нужен непустой path.';
  }
  if ('refusal' in file) {
    return file.refusal;
  }
  if (deps.io.stat(file.path) !== 'file') {
    return `Файл не найден: ${file.path}`;
  }
  try {
    return limitOutput(deps.io.readText(file.path), deps.maxOutputChars);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
