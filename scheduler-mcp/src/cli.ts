/**
 * Точка входа MCP-сервера планировщика (stdio): читает настройки из окружения, собирает движок
 * и фоновый тик, слушает по stdio. Только проводка — файл исключён из покрытия. В stdout идёт
 * протокол MCP, поэтому диагностику пишем в stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadSchedulerConfig } from './config.ts';
import { createDefaultScheduler, startTicking } from './runtime.ts';
import { createServer } from './server.ts';

async function main(): Promise<void> {
  try {
    process.loadEnvFile();
  } catch {
    // .env необязателен — используем чистое окружение.
  }
  const config = loadSchedulerConfig(process.env);
  const scheduler = createDefaultScheduler(config.storePath);
  startTicking(scheduler, config.tickIntervalMs);
  const server = createServer(scheduler);
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
