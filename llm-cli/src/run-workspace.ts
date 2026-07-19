import { join, resolve, relative, dirname } from 'node:path';
import type {
  ToolSet,
  ToolSpec,
  ProjectContext,
  ProjectCommands,
  ProjectCommandRunner,
  CommandResult,
  CommandRunOptions,
  FileWorkspace,
  CommandCheck,
  WorkspaceChangeSummary,
} from '../../core/src/index.ts';
import { CompositeToolSet } from './composite-tool-set.ts';

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
  /** Снимает СИМЛИНК (удаляет ссылку, не её цель) — для отвязки node_modules копии от реального. */
  removeSymlink(path: string): void;
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
/** Общий потолок ответа пакетного чтения read_files (бережёт контекст на многих файлах). */
const READ_FILES_TOTAL_LIMIT = 60000;
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

/** Указывает ли путь внутрь служебного каталога (node_modules/.git) относительно корня копии. */
function inServiceDir(root: string, resolved: string): boolean {
  return relative(root, resolved)
    .split(/[\\/]/)
    .some(segment => SKIP_ENTRIES.has(segment));
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
        name: 'read_files',
        description:
          'Прочитать СРАЗУ НЕСКОЛЬКО файлов проекта за один вызов (эффективнее многих read_file). ' +
          'Передай массив путей относительно корня — верну содержимое каждого.',
        parameters: {
          type: 'object',
          properties: {
            paths: {
              type: 'array',
              items: { type: 'string' },
              description: 'пути файлов относительно корня проекта',
            },
          },
          required: ['paths'],
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
        name: 'delete_file',
        description:
          'Удалить файл проекта по пути относительно корня (напр. устаревший файл или регенерируемый lock-файл). Удаление применится к проекту после подтверждения.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'путь относительно корня проекта' },
          },
          required: ['path'],
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
    if (name === 'read_files') {
      return this.readFiles(args.paths);
    }
    if (name === 'write_file') {
      return this.writeFile(stringArg(args, 'path'), stringArg(args, 'content'));
    }
    if (name === 'delete_file') {
      return this.deleteFile(stringArg(args, 'path'));
    }
    if (name === 'list_dir') {
      return this.listDir(stringArg(args, 'path') || '.');
    }
    if (name === 'grep') {
      return this.grep(stringArg(args, 'pattern'), stringArg(args, 'path') || '.');
    }
    return `Неизвестный инструмент: ${name}`;
  }

  /** Абсолютный путь внутри копии или сообщение об отказе (путь наружу / служебный каталог). */
  private inside(relativePath: string): { path: string } | { error: string } {
    if (relativePath === '') {
      return { error: 'Ошибка: не указан путь.' };
    }
    const resolved = resolveInside(this.root, relativePath);
    if (resolved === null) {
      return { error: `Ошибка: путь вне проекта: ${relativePath}` };
    }
    // Служебные каталоги (node_modules/.git) агенту недоступны: это шум и раздувание контекста
    // (минифицированные бандлы в node_modules переполняли окно → провайдер закрывал соединение).
    if (inServiceDir(this.root, resolved)) {
      return { error: `Ошибка: служебный каталог недоступен (node_modules/.git): ${relativePath}` };
    }
    return { path: resolved };
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

  /** Пакетное чтение: содержимое каждого файла с заголовком; общий потолок бережёт контекст. */
  private readFiles(rawPaths: unknown): string {
    const paths = Array.isArray(rawPaths)
      ? rawPaths.filter((path): path is string => typeof path === 'string')
      : [];
    if (paths.length === 0) {
      return 'Ошибка: не указаны пути (paths — массив путей относительно корня).';
    }
    const blocks: string[] = [];
    let total = 0;
    for (const path of paths) {
      const block = `=== ${path} ===\n${this.readFile(path)}`;
      total += block.length;
      if (total > READ_FILES_TOTAL_LIMIT && blocks.length > 0) {
        blocks.push('…(остальные файлы не показаны — превышен общий лимит; запроси их отдельно)');
        break;
      }
      blocks.push(block);
    }
    return blocks.join('\n\n');
  }

  private writeFile(path: string, content: string): string {
    const target = this.inside(path);
    if ('error' in target) {
      return target.error;
    }
    this.io.writeFile(target.path, content);
    return `Файл записан: ${path}`;
  }

  /**
   * Удаляет файл проекта. Каталоги не удаляем (только файл) — так исключены рекурсивное удаление и
   * стирание корня; сама правка идёт в изолированную копию, к реальному проекту применится после
   * подтверждения (git видит удаление, `apply` удалит файл в проекте).
   */
  private deleteFile(path: string): string {
    const target = this.inside(path);
    if ('error' in target) {
      return target.error;
    }
    if (!this.io.exists(target.path)) {
      return `Файл не найден: ${path}`;
    }
    if (this.io.isDirectory(target.path)) {
      return `Это каталог, не файл (удаление каталогов недоступно): ${path}`;
    }
    this.io.deleteFile(target.path);
    return `Файл удалён: ${path}`;
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

/** Опции запуска команды проекта: cwd + (если заданы) таймаут и переменные .env. */
function commandRunOptions(
  cwd: string,
  timeoutMs: number | undefined,
  env: Record<string, string>,
): CommandRunOptions {
  return {
    cwd,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}

/** Максимум символов вывода команды в ответе инструмента (хвост важнее — там ошибка). */
const COMMAND_TAIL_LIMIT = 2000;

/** Хвост вывода команды для ответа инструмента (последние символы stdout+stderr). */
function commandTail(result: CommandResult): string {
  const combined = `${result.stdout}\n${result.stderr}`.trim();
  return combined.length > COMMAND_TAIL_LIMIT
    ? `…${combined.slice(-COMMAND_TAIL_LIMIT)}`
    : combined;
}

/** Скрипты, которые исполнителю МОЖНО запускать: проверка/типы/линт/формат/фиксы. */
const SAFE_SCRIPT_NAME = /^(test|build|lint|type|typecheck|format|prettier|stylelint|eslint|knip|fix|check)([:_-].*)?$/i;
/** Явно опасные скрипты — не запускаем даже в копии (внешние эффекты / lifecycle). */
const UNSAFE_SCRIPT_NAME = /(deploy|publish|release|start|serve|clean|install)/i;

/** Разрешён ли скрипт к запуску исполнителем (проверочный/фиксящий, не деплой/lifecycle). */
function scriptAllowed(name: string): boolean {
  return SAFE_SCRIPT_NAME.test(name) && !UNSAFE_SCRIPT_NAME.test(name);
}

/** Менеджеры пакетов и их безопасные глаголы (установка/обновление зависимостей). Флаги после — любые. */
const PACKAGE_MANAGER_VERB =
  /^(npm|yarn|pnpm)\s+(i|install|ci|add|update|up|upgrade|remove|uninstall|dedupe|audit|outdated|ls|rebuild)\b/;
/**
 * Запуск обновлятора версий через npx — С ЛЮБЫМИ флагами перед именем (`npx --yes npm-check-updates`,
 * `npx -y ncu`): именно так его зовут неинтерактивно, чтобы npx не спрашивал подтверждение установки.
 */
const NPX_UPDATER = /^npx\b.*\b(npm-check-updates|ncu)\b/;
/** Служебные символы оболочки — их в пакетной команде не допускаем (цепочки/подстановки/перенаправления). */
const SHELL_METACHAR = /[;&|`$(){}<>\n\\]/;

/**
 * Пакетная ли это команда, безопасная к запуску исполнителем: менеджер пакетов с разрешённым глаголом
 * ИЛИ npx-запуск обновлятора версий, и БЕЗ служебных символов оболочки (одна команда, без `&&`/`;`/`|`).
 */
export function isPackageCommand(command: string): boolean {
  const trimmed = command.trim();
  if (SHELL_METACHAR.test(trimmed)) {
    return false;
  }
  return PACKAGE_MANAGER_VERB.test(trimmed) || NPX_UPDATER.test(trimmed);
}

/** Скрипты проекта из `package.json` рабочей копии (только строковые значения; нет/битый → пусто). */
export function readProjectScripts(io: WorkspaceIo, root: string): Record<string, string> {
  const manifestPath = join(root, 'package.json');
  if (!io.exists(manifestPath)) {
    return {};
  }
  try {
    const manifest = JSON.parse(io.readFile(manifestPath)) as { scripts?: Record<string, unknown> };
    const scripts = manifest.scripts;
    if (scripts === undefined || scripts === null || typeof scripts !== 'object') {
      return {};
    }
    const result: Record<string, string> = {};
    for (const [name, value] of Object.entries(scripts)) {
      if (typeof value === 'string') {
        result[name] = value;
      }
    }
    return result;
  } catch {
    return {}; // битый package.json
  }
}

/**
 * Файлы DEV-окружения, подмешиваемые в команды проекта (позже в списке — выше приоритет). Ориентированы
 * на РАЗРАБОТКУ (частые конвенции dotenv/Vite/CRA); prod/staging/test НЕ берём — там чужие/зашифрованные
 * значения, которые перекрыли бы верные dev-переменные. Нестандартное имя — через `envFiles`-оверрайд.
 */
const PROJECT_ENV_FILES = [
  '.env',
  '.env.development',
  '.env.dev',
  '.env.local',
  '.env.development.local',
  '.env.dev.local',
];

/** Разбирает содержимое `.env` (построчно `KEY=VALUE`): комментарии/пустые пропускаются, кавычки снимаются. */
export function parseDotenv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const body = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const separator = body.indexOf('=');
    if (separator <= 0) {
      continue; // нет '=' или пустой ключ
    }
    const key = body.slice(0, separator).trim();
    let value = body.slice(separator + 1).trim();
    const quote = value[0];
    if (value.length >= 2 && (quote === '"' || quote === "'") && value.at(-1) === quote) {
      value = value.slice(1, -1);
    }
    if (key !== '') {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Загружает переменные окружения проекта из dev-`.env`-файлов рабочей копии (позже в списке — выше
 * приоритет) — чтобы команды сборки/тестов видели нужные переменные локального запуска. `files` —
 * список имён (по умолчанию общий набор `PROJECT_ENV_FILES`; оверрайд для нестандартных имён). Нет
 * файлов / нечитаемы → пусто.
 */
export function loadProjectEnv(
  io: WorkspaceIo,
  root: string,
  files: string[] = PROJECT_ENV_FILES,
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const name of files) {
    const path = join(root, name);
    if (io.exists(path)) {
      try {
        Object.assign(merged, parseDotenv(io.readFile(path)));
      } catch {
        // нечитаемый .env — пропускаем
      }
    }
  }
  return merged;
}

/**
 * Инструмент запуска СКРИПТОВ проекта (`<pm> run <script>`) в рабочей копии — для этапа выполнения:
 * исполнитель проверяет/форматирует свои правки и чинит их до зелёного. Allow-list — скрипты проекта
 * (проверочные/фиксящие), деплой/lifecycle отсеиваются: команда от модели своей подкоманды не добавит.
 */
export class WorkspaceCommandToolSet implements ToolSet {
  private readonly worktree: string;
  private readonly packageManager: string;
  private readonly scripts: Record<string, string>;
  private readonly runner: ProjectCommandRunner;
  private readonly timeoutMs: number | undefined;
  private readonly projectEnv: Record<string, string>;

  constructor(
    worktree: string,
    packageManager: string,
    scripts: Record<string, string>,
    runner: ProjectCommandRunner,
    timeoutMs: number | undefined,
    projectEnv: Record<string, string> = {},
  ) {
    this.worktree = worktree;
    this.packageManager = packageManager;
    this.scripts = scripts;
    this.runner = runner;
    this.timeoutMs = timeoutMs;
    this.projectEnv = projectEnv;
  }

  /** Имена скриптов, которые разрешено запускать. */
  allowedScripts(): string[] {
    return Object.keys(this.scripts).filter(scriptAllowed);
  }

  specs(): ToolSpec[] {
    return [
      {
        name: 'run_command',
        description:
          'Запустить скрипт проекта в рабочей копии, чтобы проверить/отформатировать свои правки и ' +
          `исправить их до зелёного (напр. форматтер/линтер). Доступные скрипты: ${this.allowedScripts().join(', ')}.`,
        parameters: {
          type: 'object',
          properties: {
            script: { type: 'string', description: 'имя скрипта проекта из списка доступных' },
          },
          required: ['script'],
        },
      },
    ];
  }

  async call(name: string, args: Record<string, unknown>): Promise<string> {
    if (name !== 'run_command') {
      return `Неизвестный инструмент: ${name}`;
    }
    const script = stringArg(args, 'script');
    if (!(script in this.scripts) || !scriptAllowed(script)) {
      return `Скрипт недоступен: ${script || '(пусто)'}. Доступны: ${this.allowedScripts().join(', ') || 'нет'}`;
    }
    const result = await this.runner.run(
      `${this.packageManager} run ${script}`,
      commandRunOptions(this.worktree, this.timeoutMs, this.projectEnv),
    );
    return `${script}: код ${result.code}${result.timedOut ? ' (таймаут)' : ''}\n${commandTail(result)}`;
  }
}

/**
 * Инструмент запуска ПАКЕТНЫХ команд менеджера (`npm install`/`npm update`/`npx npm-check-updates`…)
 * для задач установки/обновления зависимостей. Делегирует в `RunWorkspace.runPackageCommand`, которая
 * перед первой такой командой даёт копии СВОЮ node_modules (реальный проект не трогается) и валидирует
 * команду (allow-list глаголов + запрет символов оболочки).
 */
export class WorkspacePackageToolSet implements ToolSet {
  private readonly runPackage: (command: string) => Promise<string>;

  constructor(runPackage: (command: string) => Promise<string>) {
    this.runPackage = runPackage;
  }

  specs(): ToolSpec[] {
    return [
      {
        name: 'run_package_command',
        description:
          'Запустить команду менеджера пакетов в рабочей копии для установки/обновления зависимостей ' +
          '(напр. `npx --yes npm-check-updates -u`, затем `npm install`; либо `npm update`). ОДНА команда ' +
          'без цепочек (`&&`/`;`/`|`). Копия получает СВОЮ node_modules — реальный проект не трогается.',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string', description: 'команда менеджера пакетов целиком' } },
          required: ['command'],
        },
      },
    ];
  }

  async call(name: string, args: Record<string, unknown>): Promise<string> {
    if (name !== 'run_package_command') {
      return `Неизвестный инструмент: ${name}`;
    }
    return this.runPackage(stringArg(args, 'command'));
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
  private readonly projectEnv: Record<string, string>;
  /** node_modules копии — симлинк на реальный проект (иначе своя/нет). Для пакетных команд снимаем. */
  private readonly symlinkedNodeModules: boolean;
  /** node_modules копии уже отвязана от реального (материализована) — чтобы снять симлинк один раз. */
  private nodeModulesMaterialized = false;

  constructor(
    project: ProjectContext,
    worktree: string,
    base: string,
    io: WorkspaceIo,
    runner: ProjectCommandRunner,
    timeoutMs: number | undefined,
    scripts: Record<string, string> = {},
    projectEnv: Record<string, string> = {},
    symlinkedNodeModules = false,
  ) {
    this.project = project;
    this.worktree = worktree;
    this.base = base;
    this.io = io;
    this.runner = runner;
    this.timeoutMs = timeoutMs;
    this.projectEnv = projectEnv;
    this.symlinkedNodeModules = symlinkedNodeModules;
    this.commands = project.commands;
    // Исполнителю — файловые инструменты + (если есть безопасные скрипты) запуск скриптов + пакетные
    // команды (установка/обновление зависимостей): сам форматирует/проверяет/обновляет и чинит до зелёного.
    const fileTools = new WorkspaceFileToolSet(worktree, io);
    const commandTools = new WorkspaceCommandToolSet(
      worktree,
      project.packageManager ?? 'npm',
      scripts,
      runner,
      timeoutMs,
      projectEnv,
    );
    const packageTools = new WorkspacePackageToolSet(command => this.runPackageCommand(command));
    const sets: ToolSet[] = [fileTools];
    if (commandTools.allowedScripts().length > 0) {
      sets.push(commandTools);
    }
    sets.push(packageTools);
    this.tools = new CompositeToolSet(sets);
  }

  /** Запуск команды проекта в копии (для этапа проверки), с переменными .env проекта. */
  run(command: string): Promise<CommandResult> {
    return this.runner.run(command, commandRunOptions(this.worktree, this.timeoutMs, this.projectEnv));
  }

  /**
   * Перед пакетной командой даёт копии СВОЮ node_modules: снимает симлинк на реальный проект (менеджер
   * соберёт свежую node_modules в копии) — установка/обновление не портит реальный node_modules. Один
   * раз за прогон; не было симлинка — ничего не делаем.
   */
  private ensureOwnNodeModules(): void {
    if (this.symlinkedNodeModules && !this.nodeModulesMaterialized) {
      this.io.removeSymlink(join(this.worktree, 'node_modules')); // снимает ссылку, не трогая её цель
      this.nodeModulesMaterialized = true;
    }
  }

  /**
   * Пакетная команда исполнителя (`npm install`/`update`/`npx npm-check-updates`…): валидируется
   * (allow-list + без символов оболочки), затем гонится в копии с её СВОЕЙ node_modules. Реальный
   * проект не трогается; в применение попадут только `package.json`/lock (node_modules gitignore-нут).
   */
  async runPackageCommand(command: string): Promise<string> {
    if (!isPackageCommand(command)) {
      return (
        `Команда недоступна: ${command || '(пусто)'}. Разрешены пакетные команды менеджера ` +
        '(`npm`/`yarn`/`pnpm` install/update/…, `npx npm-check-updates`) — ОДНА команда без символов оболочки.'
      );
    }
    this.ensureOwnNodeModules();
    const result = await this.runner.run(
      command,
      commandRunOptions(this.worktree, this.timeoutMs, this.projectEnv),
    );
    return `${command}: код ${result.code}${result.timedOut ? ' (таймаут)' : ''}\n${commandTail(result)}`;
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

  /** Список отслеживаемых файлов проекта (git ls-files) — карта раскладки для исполнителя. */
  async listFiles(): Promise<string[]> {
    const listed = await gitRun(
      this.runner,
      this.worktree,
      ['-C', this.worktree, 'ls-files'],
      this.timeoutMs,
    );
    return listed.stdout
      .split('\n')
      .map(path => path.trim())
      .filter(path => path !== '');
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

/** Пути рабочих деревьев из `git worktree list --porcelain` (строки `worktree <path>`). */
function parseWorktreePaths(porcelain: string): string[] {
  const prefix = 'worktree ';
  return porcelain
    .split('\n')
    .filter(line => line.startsWith(prefix))
    .map(line => line.slice(prefix.length).trim());
}

/** Наша ли это временная рабочая копия (каталог `llm-run-*`) — только такие подчищаем. */
const ORPHAN_WORKTREE_PATH = /[/\\]llm-run-/;

/**
 * Подчищает осиротевшие рабочие копии прогонов (worktree `llm-run-*`) в проекте: снимает их
 * регистрацию (`git worktree remove --force`) и удаляет временный каталог, плюс `git worktree prune`
 * для устаревших записей. Возвращает снятые пути. ВНИМАНИЕ: убирает ВСЕ наши `llm-run-*` — если рядом
 * работает ДРУГАЯ сессия с активным прогоном на этом же репозитории, её копия тоже снимется (редко).
 */
export async function pruneOrphanWorktrees(
  root: string,
  io: WorkspaceIo,
  runner: ProjectCommandRunner,
  timeoutMs: number | undefined,
): Promise<string[]> {
  const listed = await gitRun(
    runner,
    root,
    ['-C', root, 'worktree', 'list', '--porcelain'],
    timeoutMs,
  );
  const removed: string[] = [];
  for (const path of parseWorktreePaths(listed.stdout)) {
    if (ORPHAN_WORKTREE_PATH.test(path)) {
      await gitRun(runner, root, ['-C', root, 'worktree', 'remove', '--force', path], timeoutMs);
      io.removeDir(dirname(path)); // временный каталог-обёртка llm-run-*
      removed.push(path);
    }
  }
  await gitRun(runner, root, ['-C', root, 'worktree', 'prune'], timeoutMs);
  return removed;
}

/**
 * Базовый коммит рабочей копии — образ РАБОЧЕГО ДЕРЕВА проекта (с незакоммиченными правками), а не
 * просто HEAD. `git stash create` даёт dangling-коммит текущего состояния трекнутых файлов, НЕ трогая
 * ни рабочее дерево, ни список stash. Дерево чистое (пусто) или ошибка → откат к `HEAD`. Так пайплайн
 * видит АКТУАЛЬНЫЕ правки (напр. уже поднятую, но не закоммиченную версию зависимости — иначе он бы
 * работал от закоммиченного состояния и «не видел, что чинить»), а diff/apply считаются ОТНОСИТЕЛЬНО
 * этого образа — в изменения попадает только то, что внёс исполнитель, а не весь незакоммиченный фон.
 * Ограничение: untracked-файлы `stash create` не захватывает — они в копию не попадают.
 */
async function workingTreeBaseCommit(
  runner: ProjectCommandRunner,
  root: string,
  timeoutMs: number | undefined,
): Promise<string> {
  const created = await gitRun(runner, root, ['-C', root, 'stash', 'create'], timeoutMs);
  return created.code === 0 && created.stdout.trim() !== '' ? created.stdout.trim() : 'HEAD';
}

/**
 * Создаёт рабочее пространство прогона: git-worktree проекта во временном каталоге. База копии —
 * образ рабочего дерева (см. `workingTreeBaseCommit`), чтобы копия отражала актуальные незакоммиченные
 * правки. Если у проекта есть node_modules — пробрасывает их симлинком, чтобы команды проекта (напр.
 * `npm test`) видели зависимости в копии. Сбой git worktree → чистим временный каталог и бросаем.
 */
export async function createRunWorkspace(
  project: ProjectContext,
  io: WorkspaceIo,
  runner: ProjectCommandRunner,
  options: { timeoutMs?: number; envFiles?: string[] } = {},
): Promise<RunWorkspace> {
  const base = io.makeTempDir('llm-run-');
  const worktree = join(base, 'worktree');
  const baseCommit = await workingTreeBaseCommit(runner, project.root, options.timeoutMs);
  const added = await gitRun(
    runner,
    project.root,
    ['-C', project.root, 'worktree', 'add', '--detach', worktree, baseCommit],
    options.timeoutMs,
  );
  if (added.code !== 0) {
    io.removeDir(base);
    throw new Error(
      `Не удалось создать рабочую копию проекта (git worktree): ${added.stderr || added.stdout}`,
    );
  }
  const nodeModules = join(project.root, 'node_modules');
  const symlinkedNodeModules = io.exists(nodeModules);
  if (symlinkedNodeModules) {
    io.symlink(nodeModules, join(worktree, 'node_modules'));
  }
  // Скрипты проекта — чтобы исполнитель мог запускать проверочные/фиксящие (форматтер и т.п.);
  // переменные .env/.env.development — чтобы команды сборки/тестов видели нужное окружение.
  const scripts = readProjectScripts(io, worktree);
  const projectEnv = loadProjectEnv(io, worktree, options.envFiles ?? PROJECT_ENV_FILES);
  return new RunWorkspace(
    project,
    worktree,
    base,
    io,
    runner,
    options.timeoutMs,
    scripts,
    projectEnv,
    symlinkedNodeModules,
  );
}
