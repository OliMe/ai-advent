import type { McpServerConfig } from '../../mcp-client/src/index.ts';
import type { McpStore } from './mcp-store.ts';
import { isGitBranchTool } from './project.ts';

/** Переменная окружения git-сервера со списком разрешённых репозиториев (через запятую). */
const ALLOWED_REPOS_ENV = 'GIT_ALLOWED_REPOS';

/**
 * Имя MCP-сервера git среди подключённых — по его инструменту (`<сервер>__git_branch`). Имя сервера
 * пользователь выбирает сам в `/mcp add`, поэтому опознаём по инструментам, а не по строке «git».
 */
export function findGitServerName(toolNames: string[]): string | null {
  const branchTool = toolNames.find(isGitBranchTool);
  if (branchTool === undefined) {
    return null;
  }
  const separator = branchTool.indexOf('__');
  return separator === -1 ? null : branchTool.slice(0, separator);
}

/** Итог попытки разрешить репозиторий в git-сервере. */
export type AllowResult =
  | { kind: 'added'; config: McpServerConfig }
  | { kind: 'already' }
  | { kind: 'unavailable'; reason: string };

/** Конфигурация stdio-сервера (у него есть окружение, которым управляет клиент). */
type StdioServerConfig = Extract<McpServerConfig, { transport: 'stdio' }>;

/** Разрешённые репозитории из окружения сервера. */
function allowedRepos(config: StdioServerConfig): string[] {
  return (config.env?.[ALLOWED_REPOS_ENV] ?? '')
    .split(',')
    .map(repo => repo.trim())
    .filter(Boolean);
}

/**
 * Прописывает корень репозитория в allow-list git-сервера — привязка проекта пользователем И ЕСТЬ
 * разрешение на чтение, спрашивать его отдельно на каждый вызов инструмента (за один `/ask` их 5–8)
 * бессмысленно. Возвращает обновлённый конфиг: сервер нужно переподключить, чтобы он его прочитал.
 *
 * Пишем в `env` (`GIT_ALLOWED_REPOS`), а НЕ в позиционные аргументы: там уже лежит путь к `cli.ts`
 * и, возможно, репозитории, прописанные пользователем вручную — их клиент не должен ни трогать, ни
 * пытаться отличать от своих. Сервер объединяет аргументы, env и свой рабочий каталог, поэтому
 * добавление проекта ничего не отбирает.
 */
export function allowRepositoryInGitServer(
  store: McpStore,
  serverName: string,
  root: string,
): AllowResult {
  const servers = store.load();
  const config = servers.get(serverName);
  if (config === undefined) {
    return { kind: 'unavailable', reason: `сервер «${serverName}» не найден в конфигурации` };
  }
  if (config.transport !== 'stdio') {
    // У HTTP-сервера окружение задаёт его хозяин — клиент им не управляет.
    return {
      kind: 'unavailable',
      reason: 'git-сервер подключён по HTTP — allow-list задаёт сервер',
    };
  }
  const repos = allowedRepos(config);
  if (repos.includes(root)) {
    return { kind: 'already' };
  }
  const updated: McpServerConfig = {
    ...config,
    env: { ...config.env, [ALLOWED_REPOS_ENV]: [...repos, root].join(',') },
  };
  servers.set(serverName, updated);
  store.save(servers);
  return { kind: 'added', config: updated };
}

/** Итог попытки снять разрешение с репозитория в git-сервере. */
export type RevokeResult =
  | { kind: 'removed'; config: McpServerConfig }
  | { kind: 'absent' }
  | { kind: 'unavailable'; reason: string };

/** Окружение сервера без пустого `GIT_ALLOWED_REPOS` (удаляем ключ, а не оставляем пустую строку). */
function envWithRepos(
  config: StdioServerConfig,
  repos: string[],
): Record<string, string> | undefined {
  const rest = { ...config.env };
  delete rest[ALLOWED_REPOS_ENV];
  if (repos.length === 0) {
    return Object.keys(rest).length === 0 ? undefined : rest;
  }
  return { ...rest, [ALLOWED_REPOS_ENV]: repos.join(',') };
}

/**
 * Снимает разрешение с репозитория — зеркало `allowRepositoryInGitServer`. Трогает ТОЛЬКО
 * `env`-часть, которой владеет клиент: репозиторий, прописанный пользователем вручную (в аргументах)
 * или являющийся рабочим каталогом, не в env — его мы не убираем (`absent`), это не наша запись.
 * Список опустел → удаляем сам ключ окружения, чтобы конфиг не копил мусор.
 */
export function revokeRepositoryInGitServer(
  store: McpStore,
  serverName: string,
  root: string,
): RevokeResult {
  const servers = store.load();
  const config = servers.get(serverName);
  if (config === undefined) {
    return { kind: 'unavailable', reason: `сервер «${serverName}» не найден в конфигурации` };
  }
  if (config.transport !== 'stdio') {
    return {
      kind: 'unavailable',
      reason: 'git-сервер подключён по HTTP — allow-list задаёт сервер',
    };
  }
  const repos = allowedRepos(config);
  if (!repos.includes(root)) {
    return { kind: 'absent' };
  }
  const env = envWithRepos(
    config,
    repos.filter(repo => repo !== root),
  );
  const updated: McpServerConfig =
    env === undefined
      ? { transport: 'stdio', command: config.command, args: config.args }
      : { ...config, env };
  servers.set(serverName, updated);
  store.save(servers);
  return { kind: 'removed', config: updated };
}
