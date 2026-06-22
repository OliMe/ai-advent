/**
 * Точка входа пробного клиента: поднимает MCP-сервер Tavily по stdio, запрашивает список
 * инструментов и печатает JSON в консоль. Логика — в модулях (`tavily`/`probe`); здесь только
 * проводка к реальному SDK, поэтому файл исключён из покрытия.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolveTavilyApiKey, tavilyServerParameters } from './tavily.ts';
import { probeTools } from './probe.ts';

async function main(): Promise<void> {
  const apiKey = resolveTavilyApiKey(process.env);
  const transport = new StdioClientTransport(tavilyServerParameters(apiKey, process.env));
  const client = new Client({ name: 'mcp-probe', version: '1.0.0' });
  const tools = await probeTools({
    connect: () => client.connect(transport),
    listTools: () => client.listTools(),
    close: () => client.close(),
  });
  console.log(JSON.stringify(tools, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
