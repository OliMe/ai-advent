/**
 * Минимальный контракт MCP-клиента, достаточный для запроса списка инструментов. Узкий
 * интерфейс (а не весь SDK-клиент) позволяет подменять его в тестах и не зависеть от деталей.
 */
export interface ToolProbe {
  connect(): Promise<void>;
  listTools(): Promise<unknown>;
  close(): Promise<void>;
}

/**
 * Подключается к серверу, запрашивает список инструментов и возвращает его, гарантированно
 * закрывая соединение даже при ошибке запроса.
 */
export async function probeTools(probe: ToolProbe): Promise<unknown> {
  await probe.connect();
  try {
    return await probe.listTools();
  } finally {
    await probe.close();
  }
}
