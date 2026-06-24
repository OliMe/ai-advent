/**
 * Реальное подключение к MCP-серверу поверх официального SDK (фабрика для McpToolSet).
 * Только проводка к SDK (stdio/HTTP-транспорт, connect/listTools/callTool/close) — логика
 * маппинга вынесена в tool-mapping, поэтому файл исключён из покрытия.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServerConfig } from './config.ts';
import type { McpConnection } from './tool-set.ts';
import { extractToolText, toToolSpecs } from './tool-mapping.ts';

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

/** Подключается к MCP-серверу, читает его инструменты и возвращает McpConnection. */
export async function createConnection(
  name: string,
  config: McpServerConfig,
): Promise<McpConnection> {
  const client = new Client({ name: 'mcp-client', version: '1.0.0' });
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
}
