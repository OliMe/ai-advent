import { homedir } from 'node:os';
import { resolve, isAbsolute, join, sep } from 'node:path';

/** Разворачивает ведущую тильду в домашний каталог. */
export function expandHome(input: string): string {
  if (input === '~') {
    return homedir();
  }
  if (input.startsWith('~/')) {
    return join(homedir(), input.slice(2));
  }
  return input;
}

/** Приводит список разрешённых репозиториев к абсолютным нормализованным путям. */
export function normalizeAllowedRepos(repos: string[]): string[] {
  return repos.map(repo => resolve(expandHome(repo)));
}

/** Внутри ли абсолютный путь одного из разрешённых каталогов (или равен ему). */
export function isWithinAllowed(absolute: string, allowedRepos: string[]): boolean {
  return allowedRepos.some(repo => absolute === repo || absolute.startsWith(repo + sep));
}

/** Классификация пути: абсолютный путь и признак, что он внутри allow-list. */
export interface ResolvedPath {
  absolute: string;
  withinAllowed: boolean;
}

/**
 * Резолвит путь из запроса (разворот `~`, относительные — от первого разрешённого репозитория,
 * нормализация `..`) БЕЗ отказа и сообщает, внутри ли он allow-list. Что делать с путём вне
 * песочницы (отказать или спросить подтверждение), решает обработчик — так ассистент может
 * работать с ЛЮБЫМ проектом, а не только с прописанным в конфигурации сервера.
 */
export function classifyPath(input: string, allowedRepos: string[]): ResolvedPath {
  const expanded = expandHome(input);
  const base = allowedRepos[0] ?? homedir();
  const absolute = isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded);
  return { absolute, withinAllowed: isWithinAllowed(absolute, allowedRepos) };
}

/**
 * Резолвит путь ВНУТРИ репозитория (для чтения файла/поиска): относительный — от корня репо.
 * Выход за пределы репозитория (`../..`, абсолютный путь наружу) не разрешается ничем — это уже
 * не операция над репозиторием, а обход песочницы.
 */
export function resolveInsideRepo(repositoryRoot: string, input: string): string | null {
  const expanded = expandHome(input);
  const absolute = isAbsolute(expanded) ? resolve(expanded) : resolve(repositoryRoot, expanded);
  return isWithinAllowed(absolute, [repositoryRoot]) ? absolute : null;
}
