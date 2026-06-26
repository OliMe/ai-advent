import { homedir } from 'node:os';
import { resolve, isAbsolute, join, sep } from 'node:path';

/** Ошибка нарушения песочницы (путь вне разрешённых каталогов). */
export class SandboxError extends Error {}

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

/**
 * Резолвит путь из запроса (разворот ~, относительные — от первого разрешённого каталога,
 * нормализация `..`) и проверяет, что результат внутри allow-list. Иначе бросает SandboxError.
 */
export function resolvePath(input: string, allowedDirs: string[]): string {
  const expanded = expandHome(input);
  const base = allowedDirs[0] ?? homedir();
  const absolute = isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded);
  if (!isWithinAllowed(absolute, allowedDirs)) {
    throw new SandboxError(`Путь вне разрешённых каталогов: ${input}`);
  }
  return absolute;
}
