/**
 * Точка входа MCP-сервера RAG (stdio): читает настройки из окружения (.env), собирает боевые
 * зависимости и сервер, слушает по stdio. Только проводка — файл исключён из покрытия. В stdout
 * идёт протокол MCP, поэтому диагностику пишем в stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadRagConfig } from './config.ts';
import { createRuntimeDeps } from './runtime.ts';
import { createServer } from './server.ts';

async function main(): Promise<void> {
  try {
    process.loadEnvFile();
  } catch {
    // .env необязателен (Ollama без ключа).
  }
  const config = loadRagConfig(process.env);
  const server = createServer(createRuntimeDeps(config));
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
