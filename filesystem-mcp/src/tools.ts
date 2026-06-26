import { resolvePath } from './sandbox.ts';
import type { FsIo } from './operations.ts';

/** Зависимости обработчиков: ФС-операции и allow-list. */
export interface ToolDeps {
  io: FsIo;
  allowedDirs: string[];
}

/** Текст ошибки из неизвестного значения. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Непустая строка из аргумента или null. */
function stringArg(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** Читает файл. */
export function handleReadFile(deps: ToolDeps, args: Record<string, unknown>): string {
  const input = stringArg(args.path);
  if (input === null) {
    return 'Нужен непустой path.';
  }
  try {
    const path = resolvePath(input, deps.allowedDirs);
    if (deps.io.stat(path) !== 'file') {
      return `Файл не найден: ${input}`;
    }
    return deps.io.read(path);
  } catch (error) {
    return errorText(error);
  }
}

/** Создаёт/перезаписывает файл (родительские каталоги создаются). */
export function handleWriteFile(deps: ToolDeps, args: Record<string, unknown>): string {
  const input = stringArg(args.path);
  if (input === null) {
    return 'Нужен непустой path.';
  }
  const content = typeof args.content === 'string' ? args.content : '';
  try {
    const path = resolvePath(input, deps.allowedDirs);
    deps.io.write(path, content);
    return `Записано: ${path} (${content.length} символов)`;
  } catch (error) {
    return errorText(error);
  }
}

/** Дописывает в файл (создаёт, если нет). */
export function handleAppendFile(deps: ToolDeps, args: Record<string, unknown>): string {
  const input = stringArg(args.path);
  if (input === null) {
    return 'Нужен непустой path.';
  }
  const content = typeof args.content === 'string' ? args.content : '';
  try {
    const path = resolvePath(input, deps.allowedDirs);
    deps.io.append(path, content);
    return `Дописано в: ${path} (${content.length} символов)`;
  } catch (error) {
    return errorText(error);
  }
}

/** Список содержимого каталога (по умолчанию — первый разрешённый). */
export function handleListDir(deps: ToolDeps, args: Record<string, unknown>): string {
  const input = stringArg(args.path) ?? deps.allowedDirs[0];
  try {
    const path = resolvePath(input, deps.allowedDirs);
    if (deps.io.stat(path) !== 'dir') {
      return `Каталог не найден: ${input}`;
    }
    const entries = deps.io.list(path);
    if (entries.length === 0) {
      return `${path}: пусто`;
    }
    return entries.map(entry => `${entry.kind === 'dir' ? '📁' : '📄'} ${entry.name}`).join('\n');
  } catch (error) {
    return errorText(error);
  }
}

/**
 * Удаляет ОДИНОЧНЫЙ файл или ПУСТУЮ папку. Рекурсивного удаления нет; нельзя удалить сам
 * разрешённый корень — «удалить всё» невозможно.
 */
export function handleDeletePath(deps: ToolDeps, args: Record<string, unknown>): string {
  const input = stringArg(args.path);
  if (input === null) {
    return 'Нужен непустой path.';
  }
  try {
    const path = resolvePath(input, deps.allowedDirs);
    if (deps.allowedDirs.includes(path)) {
      return 'Нельзя удалить корневой разрешённый каталог.';
    }
    const kind = deps.io.stat(path);
    if (kind === null) {
      return `Путь не найден: ${input}`;
    }
    if (kind === 'dir') {
      if (deps.io.list(path).length > 0) {
        return 'Каталог не пуст — рекурсивное удаление запрещено.';
      }
      deps.io.removeEmptyDir(path);
      return `Удалён пустой каталог: ${path}`;
    }
    deps.io.removeFile(path);
    return `Удалён файл: ${path}`;
  } catch (error) {
    return errorText(error);
  }
}
