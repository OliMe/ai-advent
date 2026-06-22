import type { ProbeAction } from './config.ts';

/**
 * Минимальный контракт MCP-клиента, достаточный для исследования сервера. Узкий интерфейс
 * (а не весь SDK-клиент) позволяет подменять его в тестах и не зависеть от деталей транспорта.
 */
export interface McpProbe {
  connect(): Promise<void>;
  listTools(): Promise<unknown>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

/**
 * Подключается к серверу, выполняет действие (вызов инструмента или список инструментов) и
 * возвращает результат, гарантированно закрывая соединение даже при ошибке запроса.
 */
export async function runProbe(probe: McpProbe, action: ProbeAction): Promise<unknown> {
  await probe.connect();
  try {
    if (action.tool) {
      return await probe.callTool(action.tool.name, action.tool.arguments);
    }
    return await probe.listTools();
  } finally {
    await probe.close();
  }
}
