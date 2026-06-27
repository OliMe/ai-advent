/**
 * Сборка MCP-сервера поиска организаций: регистрирует инструмент find_places поверх
 * Yandex Search API. Только проводка к SDK — логика в config/yandex-geosearch/format/tools,
 * поэтому файл исключён из покрытия.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolDeps } from './tools.ts';
import { handleFindPlaces } from './tools.ts';

/** Оборачивает текст в ответ MCP-инструмента. */
function text(value: string): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: value }] };
}

/** Создаёт MCP-сервер поиска мест из deps (конфиг + fetch). */
export function createServer(deps: ToolDeps): McpServer {
  const server = new McpServer({ name: 'places-mcp', version: '1.0.0' });

  server.registerTool(
    'find_places',
    {
      title: 'Поиск организаций рядом',
      description:
        'Ищет организации (аптека, кафе, банкомат, заправка и т.п.) рядом с координатами. ' +
        'Координаты бери из инструмента геолокации (get_my_location). Аргументы: text (что искать), ' +
        'latitude, longitude; опц. radius (метры) и limit. Возвращает список с расстоянием, ' +
        'адресом, телефоном и часами.',
      inputSchema: {
        text: z.string(),
        latitude: z.number(),
        longitude: z.number(),
        radius: z.number().optional(),
        limit: z.number().optional(),
      },
    },
    async args => text(await handleFindPlaces(deps, args)),
  );

  return server;
}
