import { classifyPath } from './sandbox.ts';
import type { FsIo } from './operations.ts';

/**
 * Зависимости обработчиков: ФС-операции, allow-list и (опционально) запрос подтверждения для
 * путей вне песочницы. Без `confirm` путь вне allow-list отклоняется (поведение жёсткой песочницы);
 * с `confirm` — у пользователя спрашивают разрешение (MCP elicitation).
 */
export interface ToolDeps {
  io: FsIo;
  allowedDirs: string[];
  confirm?: (message: string) => Promise<boolean>;
}

/** Решение ворот доступа: разрешённый абсолютный путь или текст отказа. */
type Gate = { path: string } | { refusal: string };

/** Текст ошибки из неизвестного значения. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Непустая строка из аргумента или null. */
function stringArg(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * Ворота доступа к пути: внутри allow-list — пропускает; вне — запрашивает подтверждение
 * (если оно доступно), иначе отказывает. Возвращает абсолютный путь либо текст отказа.
 */
async function authorizePath(deps: ToolDeps, input: string): Promise<Gate> {
  const { absolute, withinAllowed } = classifyPath(input, deps.allowedDirs);
  if (withinAllowed) {
    return { path: absolute };
  }
  if (deps.confirm === undefined) {
    return { refusal: `Путь вне разрешённых каталогов: ${input}` };
  }
  const approved = await deps.confirm(
    `Путь «${absolute}» вне разрешённых каталогов. Разрешить операцию?`,
  );
  return approved
    ? { path: absolute }
    : { refusal: `Операция вне песочницы отклонена пользователем: ${input}` };
}

/** Читает файл. */
export async function handleReadFile(
  deps: ToolDeps,
  args: Record<string, unknown>,
): Promise<string> {
  const input = stringArg(args.path);
  if (input === null) {
    return 'Нужен непустой path.';
  }
  const gate = await authorizePath(deps, input);
  if ('refusal' in gate) {
    return gate.refusal;
  }
  try {
    if (deps.io.stat(gate.path) !== 'file') {
      return `Файл не найден: ${input}`;
    }
    return deps.io.read(gate.path);
  } catch (error) {
    return errorText(error);
  }
}

/** Создаёт/перезаписывает файл (родительские каталоги создаются). */
export async function handleWriteFile(
  deps: ToolDeps,
  args: Record<string, unknown>,
): Promise<string> {
  const input = stringArg(args.path);
  if (input === null) {
    return 'Нужен непустой path.';
  }
  const content = typeof args.content === 'string' ? args.content : '';
  const gate = await authorizePath(deps, input);
  if ('refusal' in gate) {
    return gate.refusal;
  }
  try {
    deps.io.write(gate.path, content);
    return `Записано: ${gate.path} (${content.length} символов)`;
  } catch (error) {
    return errorText(error);
  }
}

/** Дописывает в файл (создаёт, если нет). */
export async function handleAppendFile(
  deps: ToolDeps,
  args: Record<string, unknown>,
): Promise<string> {
  const input = stringArg(args.path);
  if (input === null) {
    return 'Нужен непустой path.';
  }
  const content = typeof args.content === 'string' ? args.content : '';
  const gate = await authorizePath(deps, input);
  if ('refusal' in gate) {
    return gate.refusal;
  }
  try {
    deps.io.append(gate.path, content);
    return `Дописано в: ${gate.path} (${content.length} символов)`;
  } catch (error) {
    return errorText(error);
  }
}

/** Список содержимого каталога (по умолчанию — первый разрешённый). */
export async function handleListDir(
  deps: ToolDeps,
  args: Record<string, unknown>,
): Promise<string> {
  const input = stringArg(args.path) ?? deps.allowedDirs[0];
  const gate = await authorizePath(deps, input);
  if ('refusal' in gate) {
    return gate.refusal;
  }
  try {
    if (deps.io.stat(gate.path) !== 'dir') {
      return `Каталог не найден: ${input}`;
    }
    const entries = deps.io.list(gate.path);
    if (entries.length === 0) {
      return `${gate.path}: пусто`;
    }
    return entries.map(entry => `${entry.kind === 'dir' ? '📁' : '📄'} ${entry.name}`).join('\n');
  } catch (error) {
    return errorText(error);
  }
}

/**
 * Удаляет ОДИНОЧНЫЙ файл или ПУСТУЮ папку. Рекурсивного удаления нет; нельзя удалить сам
 * разрешённый корень — «удалить всё» невозможно даже с подтверждением.
 */
export async function handleDeletePath(
  deps: ToolDeps,
  args: Record<string, unknown>,
): Promise<string> {
  const input = stringArg(args.path);
  if (input === null) {
    return 'Нужен непустой path.';
  }
  const gate = await authorizePath(deps, input);
  if ('refusal' in gate) {
    return gate.refusal;
  }
  if (deps.allowedDirs.includes(gate.path)) {
    return 'Нельзя удалить корневой разрешённый каталог.';
  }
  try {
    const kind = deps.io.stat(gate.path);
    if (kind === null) {
      return `Путь не найден: ${input}`;
    }
    if (kind === 'dir') {
      if (deps.io.list(gate.path).length > 0) {
        return 'Каталог не пуст — рекурсивное удаление запрещено.';
      }
      deps.io.removeEmptyDir(gate.path);
      return `Удалён пустой каталог: ${gate.path}`;
    }
    deps.io.removeFile(gate.path);
    return `Удалён файл: ${gate.path}`;
  } catch (error) {
    return errorText(error);
  }
}
