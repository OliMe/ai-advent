/**
 * Точка входа MCP-сервера поиска мест (stdio): читает настройки из окружения (.env), собирает
 * сервер и слушает по stdio. Только проводка — файл исключён из покрытия. В stdout идёт протокол
 * MCP, поэтому диагностику пишем в stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadPlacesConfig } from './config.ts';
import { createServer } from './server.ts';

async function main(): Promise<void> {
  try {
    process.loadEnvFile();
  } catch {
    // .env необязателен — используем чистое окружение.
  }
  const config = loadPlacesConfig(process.env);
  const server = createServer({ config, fetchFn: globalThis.fetch as never });
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
