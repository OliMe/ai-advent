/**
 * Точка входа пробного клиента: читает настройки из окружения (.env), подключается к
 * заданному MCP-серверу (stdio или Streamable HTTP), выполняет действие (вызов инструмента
 * или список инструментов) и печатает JSON в консоль. Логика — в модулях (`config`/`probe`);
 * здесь только проводка к реальному SDK, поэтому файл исключён из покрытия.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadMcpConfig, resolveProbeAction } from './config.ts';
import type { McpConfig } from './config.ts';
import { runProbe } from './probe.ts';

/** Создаёт транспорт SDK по конфигурации (stdio-процесс или Streamable HTTP). */
function createTransport(config: McpConfig): StdioClientTransport | StreamableHTTPClientTransport {
  if (config.transport === 'http') {
    return new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers: config.headers },
    });
  }
  return new StdioClientTransport({ command: config.command, args: config.args, env: config.env });
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile();
  } catch {
    // .env необязателен — используем чистое окружение.
  }
  const config = loadMcpConfig(process.env);
  // Имя инструмента — первым аргументом CLI (второй, опц., — его JSON-аргументы); иначе .env.
  const action = resolveProbeAction(process.argv.slice(2), process.env);
  const client = new Client({ name: 'mcp-probe', version: '1.0.0' });
  const transport = createTransport(config);
  const result = await runProbe(
    {
      connect: () => client.connect(transport),
      listTools: () => client.listTools(),
      callTool: (name, args) => client.callTool({ name, arguments: args }),
      close: () => client.close(),
    },
    action,
  );
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
