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

/** Приводит список разрешённых каталогов к абсолютным нормализованным путям. */
export function normalizeAllowedDirs(dirs: string[]): string[] {
  return dirs.map(dir => resolve(expandHome(dir)));
}

/** Внутри ли абсолютный путь одного из разрешённых каталогов (или равен ему). */
export function isWithinAllowed(absolute: string, allowedDirs: string[]): boolean {
  return allowedDirs.some(dir => absolute === dir || absolute.startsWith(dir + sep));
}

/** Классификация пути: абсолютный путь и признак, что он внутри allow-list. */
export interface ResolvedPath {
  absolute: string;
  withinAllowed: boolean;
}

/**
 * Резолвит путь из запроса (разворот ~, относительные — от первого разрешённого каталога,
 * нормализация `..`) БЕЗ отказа и сообщает, внутри ли он allow-list. Решение, что делать с
 * путём вне песочницы (отказать или запросить подтверждение), принимает обработчик.
 */
export function classifyPath(input: string, allowedDirs: string[]): ResolvedPath {
  const expanded = expandHome(input);
  const base = allowedDirs[0] ?? homedir();
  const absolute = isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded);
  return { absolute, withinAllowed: isWithinAllowed(absolute, allowedDirs) };
}
