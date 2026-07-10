import { createServer } from 'node:http';
import { loadGatewayConfig } from './config.ts';
import { createGatewayHandler } from './server.ts';

const config = loadGatewayConfig(process.env);
const handler = createGatewayHandler(config);

const server = createServer((request, response) => {
  handler(request, response).catch(error => {
    if (!response.headersSent) {
      response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    }
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Сбой шлюза.' }));
  });
});

server.listen(config.port, '127.0.0.1', () => {
  const authMode = config.bearerTokens.length > 0 ? 'включена' : 'ВЫКЛЮЧЕНА';
  console.log(`llm-gateway слушает 127.0.0.1:${config.port}, авторизация ${authMode}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
