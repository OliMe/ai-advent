/**
 * HTTP-точка входа MCP-сервера Yandex OCR (Streamable HTTP) — для деплоя на VPS. Каждый
 * запрос обслуживается в stateless-режиме (свой сервер+транспорт), перед обработкой —
 * проверка bearer-токена. Только проводка к SDK/express; логика OCR и авторизации — в
 * модулях (`config`/`server`/`auth`), поэтому файл исключён из покрытия.
 *
 * Запуск: PORT=3000 MCP_BEARER_TOKEN=… YANDEX_OCR_API_KEY=… node src/http.ts
 */
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadOcrConfig } from './config.ts';
import { createServer } from './server.ts';
import { authorize, requiredBearerToken } from './auth.ts';

function main(): void {
  try {
    process.loadEnvFile();
  } catch {
    // .env необязателен — используем чистое окружение.
  }
  const config = loadOcrConfig(process.env); // упадёт, если нет креденшелов Yandex
  const token = requiredBearerToken(process.env);
  const port = Number(process.env.PORT) || 3000;

  const app = express();
  app.use(express.json({ limit: '25mb' })); // изображения в base64 могут быть крупными

  app.post('/mcp', async (request, response) => {
    if (!authorize(request.headers.authorization, token)) {
      response.status(401).json({ error: 'Требуется корректный Authorization: Bearer <токен>.' });
      return;
    }
    const server = createServer(config);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    response.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request, response, request.body);
  });

  app.listen(port, () => {
    // В stdout у MCP-stdio был бы протокол; здесь HTTP, поэтому лог можно и в stdout,
    // но держим единообразно в stderr.
    console.error(
      `yandex-ocr-mcp (Streamable HTTP) слушает на :${port} (auth: ${token ? 'вкл' : 'выкл'})`,
    );
  });
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
