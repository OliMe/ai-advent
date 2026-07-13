import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** Ввод-вывод для чтения проекта (инжектируется; реальный — поверх node:fs). */
export interface ProjectIo {
  /** Тип объекта по пути или null, если его нет. */
  stat(path: string): 'file' | 'dir' | null;
  /** Имена внутри каталога. */
  list(path: string): string[];
  readText(path: string): string;
}

/** Реальная реализация поверх node:fs. */
export const nodeProjectIo: ProjectIo = {
  stat: path => (existsSync(path) ? (statSync(path).isDirectory() ? 'dir' : 'file') : null),
  list: path => readdirSync(path),
  readText: path => readFileSync(path, 'utf8'),
};

/** Команды проекта, выведенные из его манифеста (задел под тесты/сборку/деплой пайплайна). */
export interface ProjectCommands {
  test?: string;
  build?: string;
  lint?: string;
  start?: string;
}

/** Привязанный проект: корень репозитория, его документация и способ его собрать/проверить. */
export interface ProjectContext {
  /** Абсолютный путь к корню репозитория. */
  root: string;
  /** Короткое имя проекта (имя каталога) — им проект адресуют в командах и ответах. */
  name: string;
  /** URL удалённого репозитория (`origin`), если он задан. */
  origin?: string;
  /** Пути к документации: файлы (README, CLAUDE.md, схемы API) и каталоги (docs). */
  docSources: string[];
  /** Менеджер пакетов, выведенный по lock-файлу. */
  packageManager?: string;
  commands: ProjectCommands;
}

/**
 * Ищет корень репозитория, поднимаясь от каталога вверх до `.git` (файл — в worktree, каталог — в
 * обычном клоне). Не нашёл до самого верха — null: работать «в проекте», которого нет, нельзя.
 */
export function detectProjectRoot(startDirectory: string, io: ProjectIo): string | null {
  let current = startDirectory;
  for (;;) {
    if (io.stat(join(current, '.git')) !== null) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

/** Файлы документации в корне: README, заметки для ассистентов, вклад. */
const DOC_FILE_PATTERNS = [/^readme(\.[a-z]+)?$/i, /^claude\.md$/i, /^agents\.md$/i];

/** Описания API и схемы данных: их ассистент читает как документацию. */
const SCHEMA_FILE_PATTERNS = [
  /^openapi.*\.(ya?ml|json)$/i,
  /\.openapi\.(ya?ml|json)$/i,
  /^swagger.*\.(ya?ml|json)$/i,
  /^schema\.(graphql|prisma|sql)$/i,
  /\.proto$/i,
];

/** Каталоги документации. */
const DOC_DIRECTORY_NAMES = new Set(['docs', 'doc', 'documentation']);

/** Совпадает ли имя хотя бы с одним шаблоном. */
function matchesAny(name: string, patterns: RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(name));
}

/**
 * Документация проекта: README и заметки, каталог `docs`, описания API и схемы данных — то, по чему
 * строится RAG-индекс. Код сюда НЕ входит: он большой и быстро устаревает в индексе, его ассистент
 * добирает точечно инструментами git (`git_grep`/`read_file`).
 */
export function discoverDocSources(root: string, io: ProjectIo): string[] {
  let entries: string[];
  try {
    entries = io.list(root);
  } catch {
    return []; // нечитаемый корень — просто нет документации
  }
  const sources: string[] = [];
  for (const entry of entries.sort()) {
    const path = join(root, entry);
    const kind = io.stat(path);
    if (kind === 'dir' && DOC_DIRECTORY_NAMES.has(entry.toLowerCase())) {
      sources.push(path);
      continue;
    }
    if (kind === 'file' && matchesAny(entry, [...DOC_FILE_PATTERNS, ...SCHEMA_FILE_PATTERNS])) {
      sources.push(path);
    }
  }
  return sources;
}

/** Lock-файл → менеджер пакетов. */
const LOCK_FILES: [string, string][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
];

/** Менеджер пакетов проекта по lock-файлу (нет lock-файла — не угадываем). */
export function detectPackageManager(root: string, io: ProjectIo): string | undefined {
  const found = LOCK_FILES.find(([file]) => io.stat(join(root, file)) === 'file');
  return found === undefined ? undefined : found[1];
}

/** Строка скрипта из `scripts` манифеста, если она есть. */
function scriptText(scripts: Record<string, unknown>, name: string): string | undefined {
  const value = scripts[name];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * Команды проекта из `package.json` (`scripts`): чем прогнать тесты, сборку, линтер, запуск. Нужны
 * пайплайну — этап проверки должен знать, ЧЕМ проверять, а не выдумывать команду.
 */
export function detectProjectCommands(root: string, io: ProjectIo): ProjectCommands {
  let manifest: unknown;
  try {
    manifest = JSON.parse(io.readText(join(root, 'package.json')));
  } catch {
    return {}; // нет package.json или он битый — команд не знаем (не node-проект)
  }
  const scripts = (manifest as { scripts?: Record<string, unknown> }).scripts;
  if (typeof scripts !== 'object' || scripts === null) {
    return {};
  }
  const commands: ProjectCommands = {};
  for (const name of ['test', 'build', 'lint', 'start'] as const) {
    const text = scriptText(scripts, name);
    if (text !== undefined) {
      commands[name] = text;
    }
  }
  return commands;
}

/** URL секции `[remote "origin"]` в конфиге репозитория. */
const ORIGIN_URL = /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/;

/**
 * URL удалённого репозитория из `.git/config` — без запуска git (сущность проекта не должна зависеть
 * от внешнего процесса). Нет секции или конфига — undefined (локальный проект без remote).
 */
export function detectOrigin(root: string, io: ProjectIo): string | undefined {
  let config: string;
  try {
    config = io.readText(join(root, '.git', 'config'));
  } catch {
    return undefined;
  }
  const matched = ORIGIN_URL.exec(config);
  return matched === null ? undefined : matched[1];
}

/**
 * Собирает контекст проекта по корню репозитория. `docSourcesOverride` (из `LLM_PROJECT_DOCS`)
 * заменяет автоопределение документации — на случай нестандартной раскладки. Корень не является
 * репозиторием → null.
 */
export function loadProjectContext(
  root: string,
  io: ProjectIo,
  docSourcesOverride?: string[],
): ProjectContext | null {
  if (io.stat(join(root, '.git')) === null) {
    return null;
  }
  const origin = detectOrigin(root, io);
  const packageManager = detectPackageManager(root, io);
  const docSources =
    docSourcesOverride === undefined || docSourcesOverride.length === 0
      ? discoverDocSources(root, io)
      : docSourcesOverride;
  return {
    root,
    name: basename(root),
    ...(origin === undefined ? {} : { origin }),
    docSources,
    ...(packageManager === undefined ? {} : { packageManager }),
    commands: detectProjectCommands(root, io),
  };
}

/** Команды проекта одной строкой (только заданные). */
function formatCommands(commands: ProjectCommands): string {
  const named: [string, string | undefined][] = [
    ['тесты', commands.test],
    ['сборка', commands.build],
    ['линтер', commands.lint],
    ['запуск', commands.start],
  ];
  const known = named.filter(([, value]) => value !== undefined);
  return known.length === 0
    ? 'не определены'
    : known.map(([label, value]) => `${label}: \`${value}\``).join('; ');
}

/** Карточка проекта для контекста агента: что это, где лежит, где документация, чем проверять. */
export function formatProjectContext(project: ProjectContext): string {
  const lines = [
    `Проект «${project.name}»`,
    `- корень: ${project.root}`,
    ...(project.origin === undefined ? [] : [`- remote: ${project.origin}`]),
    `- документация: ${project.docSources.length === 0 ? 'не найдена' : project.docSources.join(', ')}`,
    `- команды: ${formatCommands(project.commands)}`,
  ];
  return lines.join('\n');
}

/**
 * Карточки всех привязанных проектов. Фича может жить в нескольких репозиториях сразу, поэтому
 * агент видит их вместе — и знает, что при обращении к инструментам git репозиторий (`repo`) надо
 * называть явно.
 */
export function formatWorkspace(projects: ProjectContext[]): string {
  if (projects.length === 0) {
    return '';
  }
  const cards = projects.map(formatProjectContext).join('\n\n');
  const note =
    projects.length > 1
      ? '\n\nПроектов несколько: в инструментах git указывай нужный репозиторий аргументом repo ' +
        `(${projects.map(project => project.root).join(', ')}).`
      : '';
  return `Рабочее пространство проектов:\n\n${cards}${note}`;
}
