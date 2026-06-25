/**
 * HTTP-точка входа MCP-сервера планировщика (Streamable HTTP) — для деплоя на VPS. Движок и
 * фоновый тик создаются ОДИН раз (синглтон), а на каждый запрос — свежий MCP-сервер поверх того
 * же движка, в stateless-режиме, с проверкой bearer-токена. Только проводка — файл исключён из
 * покрытия.
 *
 * Запуск: PORT=3000 MCP_BEARER_TOKEN=… node src/http.ts
 */
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadSchedulerConfig } from './config.ts';
import { createDefaultScheduler, startTicking } from './runtime.ts';
import { createServer } from './server.ts';
import { authorize, requiredBearerToken } from './auth.ts';

function main(): void {
  try {
    process.loadEnvFile();
  } catch {
    // .env необязателен — используем чистое окружение.
  }
  const config = loadSchedulerConfig(process.env);
  const token = requiredBearerToken(process.env);
  const scheduler = createDefaultScheduler(config.storePath);
  startTicking(scheduler, config.tickIntervalMs);

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.post('/mcp', async (request, response) => {
    if (!authorize(request.headers.authorization, token)) {
      response.status(401).json({ error: 'Требуется корректный Authorization: Bearer <токен>.' });
      return;
    }
    const server = createServer(scheduler);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    response.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request, response, request.body);
  });

  app.listen(config.port, () => {
    console.error(
      `scheduler-mcp (Streamable HTTP) слушает на :${config.port} (auth: ${token ? 'вкл' : 'выкл'})`,
    );
  });
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
