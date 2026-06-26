import { normalizeAllowedDirs } from './sandbox.ts';

/**
 * Определяет разрешённые каталоги (allow-list). Приоритет — позиционные аргументы (пути),
 * иначе переменная FS_ALLOWED_DIRS (каталоги через запятую). Пусто — ошибка (без песочницы
 * сервер не запускаем). Возвращает абсолютные нормализованные пути.
 */
export function loadAllowedDirs(args: string[], env: NodeJS.ProcessEnv): string[] {
  const fromArgs = args.map(value => value.trim()).filter(Boolean);
  const fromEnv = (env.FS_ALLOWED_DIRS ?? '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  const dirs = fromArgs.length > 0 ? fromArgs : fromEnv;
  if (dirs.length === 0) {
    throw new Error(
      'Не задан ни один разрешённый каталог: передайте путь(и) аргументом или FS_ALLOWED_DIRS.',
    );
  }
  return normalizeAllowedDirs(dirs);
}
