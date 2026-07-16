import type { TicketProvider } from './provider.ts';
import { markComment } from './loop-guard.ts';

/** Зависимости инструментов: провайдер тикет-системы + потолок вывода. */
export interface ToolDeps {
  provider: TicketProvider;
  maxOutputChars: number;
}

/** Непустая строка из аргумента или null. */
function stringArg(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** Целое из аргумента или null. */
function numberArg(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : null;
}

/** Целое в границах или значение по умолчанию. */
function boundedNumberArg(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(Math.floor(parsed), min), max);
}

/** Длинный вывод усекается с честной пометкой. */
function limitOutput(text: string, maxChars: number): string {
  return text.length <= maxChars
    ? text
    : `${text.slice(0, maxChars)}\n… (вывод усечён: ${text.length} символов, показано ${maxChars})`;
}

/** Строгий JSON-вывод инструмента (усечённый по потолку). */
function jsonOutput(deps: ToolDeps, value: unknown): string {
  return limitOutput(JSON.stringify(value), deps.maxOutputChars);
}

/** Ошибка аргумента как валидный JSON (бот может её разобрать). */
function errorJson(message: string): string {
  return JSON.stringify({ error: message });
}

/** Один тикет по id → JSON. */
export async function handleGetTicket(
  deps: ToolDeps,
  args: Record<string, unknown>,
): Promise<string> {
  const id = numberArg(args.id);
  if (id === null) {
    return errorJson('нужен числовой id тикета');
  }
  return jsonOutput(deps, await deps.provider.getTicket(id));
}

/** Открытые тикеты (до limit, дефолт 20) → JSON-массив. */
export async function handleListTickets(
  deps: ToolDeps,
  args: Record<string, unknown>,
): Promise<string> {
  const limit = boundedNumberArg(args.limit, 20, 1, 100);
  return jsonOutput(deps, await deps.provider.listTickets(limit));
}

/** Поиск тикетов по тексту (до limit) → JSON-массив. */
export async function handleSearchTickets(
  deps: ToolDeps,
  args: Record<string, unknown>,
): Promise<string> {
  const query = stringArg(args.query);
  if (query === null) {
    return errorJson('нужен непустой query');
  }
  const limit = boundedNumberArg(args.limit, 20, 1, 100);
  return jsonOutput(deps, await deps.provider.searchTickets(query, limit));
}

/** Комментарии треда тикета → JSON-массив. */
export async function handleGetTicketComments(
  deps: ToolDeps,
  args: Record<string, unknown>,
): Promise<string> {
  const id = numberArg(args.id);
  if (id === null) {
    return errorJson('нужен числовой id тикета');
  }
  return jsonOutput(deps, await deps.provider.getComments(id));
}

/**
 * Добавить комментарий в тред. Тело ПОМЕЧАЕТСЯ скрытым маркером бота (защита от петли: ассистент не
 * отвечает на собственный комментарий). Возвращает созданный комментарий → JSON.
 */
export async function handleAddTicketComment(
  deps: ToolDeps,
  args: Record<string, unknown>,
): Promise<string> {
  const id = numberArg(args.id);
  if (id === null) {
    return errorJson('нужен числовой id тикета');
  }
  const body = stringArg(args.body);
  if (body === null) {
    return errorJson('нужен непустой body');
  }
  return jsonOutput(deps, await deps.provider.addComment(id, markComment(body)));
}
