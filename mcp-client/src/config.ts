/** Конфигурация одного MCP-сервера: stdio (локальный процесс) или Streamable HTTP. */
export type McpServerConfig =
  | { transport: 'stdio'; command: string; args: string[]; env?: Record<string, string> }
  | { transport: 'http'; url: string; headers?: Record<string, string> };

/** Объект (не массив/не null) из значения, иначе undefined. */
function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Строка из значения, иначе undefined. */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Массив строк из значения (нестроки отброшены). */
function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/** Запись «строка → строка» из значения (нестроковые значения отброшены), иначе undefined. */
function asStringRecord(value: unknown): Record<string, string> | undefined {
  const object = asObject(value);
  if (object === undefined) {
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(object)) {
    if (typeof item === 'string') {
      result[key] = item;
    }
  }
  return result;
}

/** Разбирает одну запись mcpServers (Claude-Desktop-подобный формат): url → http, иначе stdio. */
export function parseServerConfig(name: string, raw: unknown): McpServerConfig {
  const entry = asObject(raw);
  if (entry === undefined) {
    throw new Error(`MCP-сервер «${name}»: запись должна быть объектом.`);
  }
  const url = asString(entry.url);
  if (url !== undefined) {
    const headers = asStringRecord(entry.headers);
    return { transport: 'http', url, ...(headers ? { headers } : {}) };
  }
  const command = asString(entry.command);
  if (command === undefined) {
    throw new Error(`MCP-сервер «${name}»: задайте command (stdio) или url (http).`);
  }
  const env = asStringRecord(entry.env);
  return { transport: 'stdio', command, args: asStringArray(entry.args), ...(env ? { env } : {}) };
}

/** Разбирает карту mcpServers из mcp.json в Map<имя, конфиг> (пусто, если карты нет). */
export function parseServers(json: unknown): Map<string, McpServerConfig> {
  const servers = asObject(asObject(json)?.mcpServers) ?? {};
  const result = new Map<string, McpServerConfig>();
  for (const [name, raw] of Object.entries(servers)) {
    result.set(name, parseServerConfig(name, raw));
  }
  return result;
}
