/**
 * Реальное подключение к MCP-серверу поверх официального SDK (фабрика для McpToolSet).
 * Только проводка к SDK (stdio/HTTP-транспорт, connect/listTools/callTool/close) — логика
 * маппинга вынесена в tool-mapping, поэтому файл исключён из покрытия.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { McpServerConfig } from './config.ts';
import type { ConnectFn } from './tool-set.ts';
import { extractToolText, toToolSpecs } from './tool-mapping.ts';

/** Запрос подтверждения от сервера (MCP elicitation): что подтвердить. */
export interface ElicitationRequest {
  message: string;
}

/** Ответ пользователя на запрос подтверждения. */
export interface ElicitationResponse {
  action: 'accept' | 'decline' | 'cancel';
}

/** Обработчик запросов подтверждения от серверов (реализуется в приложении: спросить пользователя). */
export type ElicitationHandler = (request: ElicitationRequest) => Promise<ElicitationResponse>;

/** Создаёт транспорт SDK по конфигурации сервера (stdio-процесс или Streamable HTTP). */
function createTransport(
  config: McpServerConfig,
): StdioClientTransport | StreamableHTTPClientTransport {
  if (config.transport === 'http') {
    return new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers: config.headers },
    });
  }
  return new StdioClientTransport({ command: config.command, args: config.args, env: config.env });
}

/**
 * Фабрика подключений. Если задан обработчик подтверждений (onElicit), клиент объявляет
 * поддержку elicitation и переадресует серверные запросы `elicitation/create` приложению
 * (так filesystem-сервер может спросить разрешение на операцию вне песочницы).
 */
export function connectionFactory(onElicit?: ElicitationHandler): ConnectFn {
  return async (name, config) => {
    const client = new Client(
      { name: 'mcp-client', version: '1.0.0' },
      onElicit ? { capabilities: { elicitation: {} } } : undefined,
    );
    if (onElicit) {
      client.setRequestHandler(ElicitRequestSchema, async request => {
        const response = await onElicit({ message: request.params.message });
        return { action: response.action };
      });
    }
    await client.connect(createTransport(config));
    const listed = await client.listTools();
    const specs = toToolSpecs(listed.tools);
    return {
      name,
      tools: () => specs,
      call: async (toolName, args) =>
        extractToolText(await client.callTool({ name: toolName, arguments: args })),
      close: () => client.close(),
    };
  };
}

/** Подключение к MCP-серверу без обработки подтверждений (поведение по умолчанию). */
export const createConnection: ConnectFn = connectionFactory();
