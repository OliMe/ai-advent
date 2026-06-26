/**
 * Точка входа MCP-сервера файловой системы (stdio): разрешённые каталоги — из аргументов
 * командной строки (или FS_ALLOWED_DIRS). Только проводка — файл исключён из покрытия. В stdout
 * идёт протокол MCP, поэтому диагностику пишем в stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadAllowedDirs } from './config.ts';
import { nodeFsIo } from './operations.ts';
import { createServer } from './server.ts';

async function main(): Promise<void> {
  const allowedDirs = loadAllowedDirs(process.argv.slice(2), process.env);
  const server = createServer({ io: nodeFsIo, allowedDirs });
  console.error(`filesystem-mcp: разрешённые каталоги — ${allowedDirs.join(', ')}`);
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
