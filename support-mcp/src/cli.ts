/**
 * Точка входа MCP-сервера поддержки (stdio): конфиг из окружения (`SUPPORT_*`/`GITHUB_*`), провайдер
 * тикет-системы (GitHub Issues) поверх реального fetch. Только проводка — вне покрытия. В stdout идёт
 * протокол MCP, поэтому диагностику пишем в stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { FetchLike } from '../../core/src/index.ts';
import { loadSupportConfig } from './config.ts';
import { createProvider } from './provider.ts';
import { createServer } from './server.ts';

async function main(): Promise<void> {
  const config = loadSupportConfig(process.env);
  if (config.repo === '') {
    throw new Error('Не задан SUPPORT_REPO (owner/name) — укажите репозиторий-трекер.');
  }
  const provider = createProvider(
    config,
    globalThis.fetch as unknown as FetchLike,
    ms => new Promise(resolve => setTimeout(resolve, ms)),
  );
  const server = createServer({ provider, maxOutputChars: config.maxOutputChars });
  console.error(
    `support-mcp: трекер ${config.repo} (${config.provider}), API ${config.apiBaseUrl}`,
  );
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
