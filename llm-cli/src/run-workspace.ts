import { join, resolve, relative } from 'node:path';
import type {
  ToolSet,
  ToolSpec,
  ProjectContext,
  ProjectCommands,
  ProjectCommandRunner,
  CommandResult,
  FileWorkspace,
  CommandCheck,
  WorkspaceChangeSummary,
} from '../../core/src/index.ts';

/**
 * Рабочее пространство прогона пайплайна (День 34): изолированная git-копия (worktree) проекта, в
 * которой этап выполнения РЕАЛЬНО правит файлы, а проверка гоняет команды проекта — рабочее дерево
 * пользователя не трогается до подтверждения. diff берётся из git, применение — копированием
 * изменённых файлов в реальный проект. Логика с инъекцией файлового IO и запуска команд (реальные
 * node-биндинги — в run-workspace-io.ts, вне покрытия).
 */

/** Файловый ввод-вывод пространства (инжектируется; реальный — поверх node:fs). */
export interface WorkspaceIo {
  /** Читает файл (бросает, если недоступен). */
  readFile(path: string): string;
  /** Пишет файл, создавая родительские каталоги. */
  writeFile(path: string, content: string): void;
  /** Существует ли путь. */
  exists(path: string): boolean;
  /** Каталог ли это. */
  isDirectory(path: string): boolean;
  /** Имена внутри каталога. */
  listDir(path: string): string[];
  /** Удаляет файл (если есть). */
  deleteFile(path: string): void;
  /** Копирует файл, создавая родительские каталоги приёмника. */
  copyFile(source: string, destination: string): void;
  /** Создаёт симлинк-каталог (для проброса node_modules в копию). */
  symlink(target: string, linkPath: string): void;
  /** Создаёт свежий временный каталог с указанным префиксом и возвращает путь. */
  makeTempDir(prefix: string): string;
  /** Рекурсивно удаляет каталог. */
  removeDir(path: string): void;
}

/** Максимум символов содержимого файла в ответе инструмента (защита контекста). */
const READ_FILE_LIMIT = 20000;
/** Максимум строк-совпадений grep в ответе. */
const GREP_MATCH_LIMIT = 100;
/** Каталоги, не участвующие в чтении/поиске/копировании. */
const SKIP_ENTRIES = new Set(['.git', 'node_modules']);

/** Строка-аргумент для shell-команды git: простые — как есть, прочие — в кавычках. */
function quoteArg(arg: string): string {
  return /^[\w./-]+$/.test(arg) ? arg : `"${arg.replace(/(["\\$`])/g, '\\$1')}"`;
}

/** Запускает git с фиксированными аргументами (аргументы наши, не от модели). */
function gitRun(
  runner: ProjectCommandRunner,
  cwd: string,
  args: string[],
  timeoutMs: number | undefined,
): Promise<CommandResult> {
  const command = `git ${args.map(quoteArg).join(' ')}`;
  return runner.run(command, timeoutMs === undefined ? { cwd } : { cwd, timeoutMs });
}

/**
 * Резолвит путь ОТНОСИТЕЛЬНО корня пространства, не выпуская за его пределы. Путь наружу (`../`,
 * абсолютный) → null: агент работает только внутри копии проекта.
 */
export function resolveInside(base: string, relativePath: string): string | null {
  const resolved = resolve(base, relativePath);
  // relative() возвращает «../…» для пути наружу и «» для самого base — оба ловятся startsWith.
  return relative(base, resolved).startsWith('..') ? null : resolved;
}

/** Рекурсивно собирает файлы каталога (кроме служебных), для grep. */
function collectFiles(io: WorkspaceIo, dir: string, acc: string[]): void {
  for (const name of io.listDir(dir)) {
    if (SKIP_ENTRIES.has(name)) {
      continue;
    }
    const full = join(dir, name);
    if (io.isDirectory(full)) {
      collectFiles(io, full, acc);
    } else {
      acc.push(full);
    }
  }
}

/** Извлекает строковый аргумент инструмента (пустой/не строка → ''). */
function stringArg(args: Record<string, unknown>, name: string): string {
  return typeof args[name] === 'string' ? (args[name] as string) : '';
}

/**
 * Набор инструментов работы с файлами проекта для агента-исполнителя: чтение, запись (создание/
 * изменение), список каталога и поиск подстроки. Пути — ОТНОСИТЕЛЬНО корня проекта; физически всё
 * идёт в изолированную копию (агент про неё не знает).
 */
export class WorkspaceFileToolSet implements ToolSet {
  private readonly root: string;
  private readonly io: WorkspaceIo;

  constructor(root: string, io: WorkspaceIo) {
    this.root = root;
    this.io = io;
  }

  specs(): ToolSpec[] {
    return [
      {
        name: 'read_file',
        description: 'Прочитать файл проекта по пути относительно корня.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: 'путь относительно корня проекта' } },
          required: ['path'],
        },
      },
      {
        name: 'write_file',
        description: 'Создать или полностью перезаписать файл проекта содержимым.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'путь относительно корня проекта' },
            content: { type: 'string', description: 'новое содержимое файла целиком' },
          },
          required: ['path', 'content'],
        },
      },
      {
        name: 'list_dir',
        description: 'Список файлов и подкаталогов каталога проекта.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: 'каталог (по умолчанию корень)' } },
        },
      },
      {
        name: 'grep',
        description: 'Найти строки с подстрокой в файлах проекта.',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'искомая подстрока' },
            path: { type: 'string', description: 'каталог поиска (по умолчанию корень)' },
          },
          required: ['pattern'],
        },
      },
    ];
  }

  async call(name: string, args: Record<string, unknown>): Promise<string> {
    if (name === 'read_file') {
      return this.readFile(stringArg(args, 'path'));
    }
    if (name === 'write_file') {
      return this.writeFile(stringArg(args, 'path'), stringArg(args, 'content'));
    }
    if (name === 'list_dir') {
      return this.listDir(stringArg(args, 'path') || '.');
    }
    if (name === 'grep') {
      return this.grep(stringArg(args, 'pattern'), stringArg(args, 'path') || '.');
    }
    return `Неизвестный инструмент: ${name}`;
  }

  /** Абсолютный путь внутри копии или сообщение об отказе (путь наружу). */
  private inside(relativePath: string): { path: string } | { error: string } {
    if (relativePath === '') {
      return { error: 'Ошибка: не указан путь.' };
    }
    const resolved = resolveInside(this.root, relativePath);
    return resolved === null
      ? { error: `Ошибка: путь вне проекта: ${relativePath}` }
      : { path: resolved };
  }

  private readFile(path: string): string {
    const target = this.inside(path);
    if ('error' in target) {
      return target.error;
    }
    if (!this.io.exists(target.path)) {
      return `Файл не найден: ${path}`;
    }
    const content = this.io.readFile(target.path);
    return content.length > READ_FILE_LIMIT
      ? `${content.slice(0, READ_FILE_LIMIT)}\n…(файл усечён)`
      : content;
  }

  private writeFile(path: string, content: string): string {
    const target = this.inside(path);
    if ('error' in target) {
      return target.error;
    }
    this.io.writeFile(target.path, content);
    return `Файл записан: ${path}`;
  }

  private listDir(path: string): string {
    const target = this.inside(path);
    if ('error' in target) {
      return target.error;
    }
    if (!this.io.isDirectory(target.path)) {
      return `Не каталог: ${path}`;
    }
    const names = this.io.listDir(target.path).filter(name => !SKIP_ENTRIES.has(name));
    return names.length === 0 ? '(пусто)' : names.join('\n');
  }

  private grep(pattern: string, path: string): string {
    if (pattern === '') {
      return 'Ошибка: не указана подстрока поиска.';
    }
    const target = this.inside(path);
    if ('error' in target) {
      return target.error;
    }
    if (!this.io.exists(target.path)) {
      return `Путь не найден: ${path}`;
    }
    // Каталог — обходим рекурсивно; файл — ищем в нём одном.
    const files: string[] = [];
    if (this.io.isDirectory(target.path)) {
      collectFiles(this.io, target.path, files);
    } else {
      files.push(target.path);
    }
    const matches: string[] = [];
    for (const file of files) {
      const relativePath = relative(this.root, file);
      let content: string;
      try {
        content = this.io.readFile(file);
      } catch {
        continue; // нечитаемый (напр. бинарный) файл — пропускаем
      }
      const lines = content.split('\n');
      for (let index = 0; index < lines.length; index++) {
        if (lines[index].includes(pattern)) {
          matches.push(`${relativePath}:${index + 1}: ${lines[index].trim()}`);
          if (matches.length >= GREP_MATCH_LIMIT) {
            return `${matches.join('\n')}\n…(показаны первые ${GREP_MATCH_LIMIT})`;
          }
        }
      }
    }
    return matches.length === 0 ? `Совпадений не найдено: ${pattern}` : matches.join('\n');
  }
}

/** Изменение файла в копии: статус git (A/M/D) + путь относительно корня. */
interface WorkspaceChange {
  status: string;
  path: string;
}

/** Разбирает вывод `git diff --name-status` в список изменений (A/M/D + путь). */
function parseNameStatus(output: string): WorkspaceChange[] {
  const changes: WorkspaceChange[] = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') {
      continue;
    }
    const parts = trimmed.split('\t');
    const path = parts.slice(1).join('\t').trim();
    if (path !== '') {
      changes.push({ status: parts[0][0], path });
    }
  }
  return changes;
}

/**
 * Пространство прогона: изолированная git-копия проекта. Реализует `FileWorkspace` (инструменты +
 * снимок изменений) и `CommandCheck` (запуск команд проекта в копии), плюс `apply` (перенос правок в
 * реальный проект после подтверждения) и `dispose` (удаление копии).
 */
export class RunWorkspace implements FileWorkspace, CommandCheck {
  readonly tools: ToolSet;
  readonly commands: ProjectCommands;
  private readonly project: ProjectContext;
  private readonly worktree: string;
  private readonly base: string;
  private readonly io: WorkspaceIo;
  private readonly runner: ProjectCommandRunner;
  private readonly timeoutMs: number | undefined;

  constructor(
    project: ProjectContext,
    worktree: string,
    base: string,
    io: WorkspaceIo,
    runner: ProjectCommandRunner,
    timeoutMs: number | undefined,
  ) {
    this.project = project;
    this.worktree = worktree;
    this.base = base;
    this.io = io;
    this.runner = runner;
    this.timeoutMs = timeoutMs;
    this.tools = new WorkspaceFileToolSet(worktree, io);
    this.commands = project.commands;
  }

  /** Запуск команды проекта в копии (для этапа проверки). */
  run(command: string): Promise<CommandResult> {
    return this.runner.run(
      command,
      this.timeoutMs === undefined
        ? { cwd: this.worktree }
        : { cwd: this.worktree, timeoutMs: this.timeoutMs },
    );
  }

  /** Ставит все правки в индекс и возвращает список изменений (A/M/D). */
  private async staged(): Promise<WorkspaceChange[]> {
    await gitRun(this.runner, this.worktree, ['-C', this.worktree, 'add', '-A'], this.timeoutMs);
    const status = await gitRun(
      this.runner,
      this.worktree,
      ['-C', this.worktree, 'diff', '--cached', '--no-renames', '--name-status'],
      this.timeoutMs,
    );
    return parseNameStatus(status.stdout);
  }

  async changeSummary(): Promise<WorkspaceChangeSummary> {
    const changes = await this.staged();
    const diff = await gitRun(
      this.runner,
      this.worktree,
      ['-C', this.worktree, 'diff', '--cached', '--no-renames'],
      this.timeoutMs,
    );
    return { diff: diff.stdout, files: changes.map(change => change.path) };
  }

  /**
   * Переносит правки копии в реальный проект: A/M — копированием файла, D — удалением. Вызывается
   * драйвером ПОСЛЕ подтверждения завершения. Возвращает применённые пути.
   */
  async apply(): Promise<string[]> {
    const changes = await this.staged();
    for (const change of changes) {
      const target = join(this.project.root, change.path);
      if (change.status === 'D') {
        this.io.deleteFile(target);
      } else {
        this.io.copyFile(join(this.worktree, change.path), target);
      }
    }
    return changes.map(change => change.path);
  }

  /** Удаляет копию (worktree + временный каталог). Best-effort: не бросает — сбой очистки не важен. */
  async dispose(): Promise<void> {
    await gitRun(
      this.runner,
      this.project.root,
      ['-C', this.project.root, 'worktree', 'remove', '--force', this.worktree],
      this.timeoutMs,
    );
    try {
      this.io.removeDir(this.base);
    } catch {
      // очистка временного каталога не критична — оставляем как есть
    }
  }
}

/**
 * Создаёт рабочее пространство прогона: git-worktree проекта от HEAD во временном каталоге. Если у
 * проекта есть node_modules — пробрасывает их симлинком, чтобы команды проекта (напр. `npm test`)
 * видели зависимости в копии. Сбой git worktree → чистим временный каталог и бросаем.
 */
export async function createRunWorkspace(
  project: ProjectContext,
  io: WorkspaceIo,
  runner: ProjectCommandRunner,
  options: { timeoutMs?: number } = {},
): Promise<RunWorkspace> {
  const base = io.makeTempDir('llm-run-');
  const worktree = join(base, 'worktree');
  const added = await gitRun(
    runner,
    project.root,
    ['-C', project.root, 'worktree', 'add', '--detach', worktree, 'HEAD'],
    options.timeoutMs,
  );
  if (added.code !== 0) {
    io.removeDir(base);
    throw new Error(
      `Не удалось создать рабочую копию проекта (git worktree): ${added.stderr || added.stdout}`,
    );
  }
  const nodeModules = join(project.root, 'node_modules');
  if (io.exists(nodeModules)) {
    io.symlink(nodeModules, join(worktree, 'node_modules'));
  }
  return new RunWorkspace(project, worktree, base, io, runner, options.timeoutMs);
}
