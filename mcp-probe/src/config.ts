/** Конфигурация подключения к MCP-серверу: stdio (локальный процесс) или Streamable HTTP. */
export type McpConfig =
  | { transport: 'stdio'; command: string; args: string[]; env: Record<string, string> }
  | { transport: 'http'; url: string; headers: Record<string, string> };

/** Что запросить у сервера: вызвать конкретный инструмент или (по умолчанию) список инструментов. */
export interface ProbeAction {
  tool?: { name: string; arguments: Record<string, unknown> };
}

/** Возвращает обязательную переменную окружения (без пробелов) или бросает ошибку. */
function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Не задана переменная окружения ${name}.`);
  }
  return value;
}

/** Определяет транспорт: явный MCP_TRANSPORT, иначе вывод из MCP_URL (http) / MCP_COMMAND (stdio). */
function resolveTransportKind(env: NodeJS.ProcessEnv): 'stdio' | 'http' {
  const explicit = env.MCP_TRANSPORT?.trim().toLowerCase();
  if (explicit === 'stdio' || explicit === 'http') {
    return explicit;
  }
  if (explicit !== undefined && explicit !== '') {
    throw new Error(`Неизвестный MCP_TRANSPORT: «${explicit}». Допустимо: stdio | http.`);
  }
  if (env.MCP_URL?.trim()) {
    return 'http';
  }
  if (env.MCP_COMMAND?.trim()) {
    return 'stdio';
  }
  throw new Error('Не настроен сервер: задайте MCP_COMMAND (stdio) или MCP_URL (http) в .env.');
}

/** Разбирает аргументы команды сервера из строки (разделитель — пробелы). */
export function parseArgs(raw: string | undefined): string[] {
  return raw ? raw.trim().split(/\s+/).filter(Boolean) : [];
}

/** HTTP-заголовки из MCP_HEADERS («Имя: значение», пары через «;») + MCP_BEARER_TOKEN. */
export function parseHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const headers: Record<string, string> = {};
  const raw = env.MCP_HEADERS?.trim();
  if (raw) {
    for (const pair of raw.split(';')) {
      const separator = pair.indexOf(':');
      if (separator === -1) {
        continue;
      }
      const name = pair.slice(0, separator).trim();
      if (name) {
        headers[name] = pair.slice(separator + 1).trim();
      }
    }
  }
  const bearer = env.MCP_BEARER_TOKEN?.trim();
  if (bearer) {
    headers.Authorization = `Bearer ${bearer}`;
  }
  return headers;
}

/** Копия окружения только с заданными значениями (для проброса дочернему процессу сервера). */
function definedStringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined) {
      result[name] = value;
    }
  }
  return result;
}

/** Собирает конфигурацию подключения к MCP-серверу из переменных окружения. */
export function loadMcpConfig(env: NodeJS.ProcessEnv): McpConfig {
  if (resolveTransportKind(env) === 'http') {
    return { transport: 'http', url: requireEnv(env, 'MCP_URL'), headers: parseHeaders(env) };
  }
  return {
    transport: 'stdio',
    command: requireEnv(env, 'MCP_COMMAND'),
    args: parseArgs(env.MCP_ARGS),
    // Всё окружение (включая .env) форвардится серверу — так он получит свои API-ключи.
    env: definedStringEnv(env),
  };
}

/** Разбирает аргументы вызова инструмента (JSON-объект) из MCP_TOOL_ARGS. */
function parseToolArguments(raw: string | undefined): Record<string, unknown> {
  const text = raw?.trim();
  if (!text) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('MCP_TOOL_ARGS должен быть корректным JSON-объектом.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('MCP_TOOL_ARGS должен быть JSON-объектом.');
  }
  return parsed as Record<string, unknown>;
}

/** Определяет действие из окружения: вызвать инструмент (MCP_TOOL) или список инструментов. */
export function loadProbeAction(env: NodeJS.ProcessEnv): ProbeAction {
  const name = env.MCP_TOOL?.trim();
  if (!name) {
    return {};
  }
  return { tool: { name, arguments: parseToolArguments(env.MCP_TOOL_ARGS) } };
}

/**
 * Определяет действие с приоритетом аргументов командной строки над окружением: первый
 * позиционный аргумент — имя инструмента, второй (опц.) — его аргументы JSON-объектом. Если
 * имя в командной строке не передано — берётся из окружения (MCP_TOOL); иначе — список
 * инструментов.
 */
export function resolveProbeAction(argv: string[], env: NodeJS.ProcessEnv): ProbeAction {
  const name = argv[0]?.trim();
  if (name) {
    return { tool: { name, arguments: parseToolArguments(argv[1]) } };
  }
  return loadProbeAction(env);
}
