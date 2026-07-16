/**
 * Сборка MCP-сервера поддержки: регистрирует инструменты обобщённого ticket-контракта. Только
 * проводка к SDK — логика в provider/tools, поэтому файл исключён из покрытия.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolDeps } from './tools.ts';
import {
  handleGetTicket,
  handleListTickets,
  handleSearchTickets,
  handleGetTicketComments,
  handleAddTicketComment,
} from './tools.ts';

/** Оборачивает текст в ответ MCP-инструмента. */
function text(value: string): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: value }] };
}

/** Создаёт MCP-сервер поддержки. Инструменты отдают строгий JSON (для детерминированного бота). */
export function createServer(deps: ToolDeps): McpServer {
  const server = new McpServer({ name: 'support-mcp', version: '1.0.0' });

  server.registerTool(
    'get_ticket',
    {
      title: 'Тикет по id',
      description: 'Обращение пользователя (для GitHub — issue) по id. Возвращает JSON тикета.',
      inputSchema: { id: z.number() },
    },
    async args => text(await handleGetTicket(deps, args)),
  );

  server.registerTool(
    'list_tickets',
    {
      title: 'Открытые тикеты',
      description: 'Список открытых тикетов (limit — сколько, по умолчанию 20). JSON-массив.',
      inputSchema: { limit: z.number().optional() },
    },
    async args => text(await handleListTickets(deps, args)),
  );

  server.registerTool(
    'search_tickets',
    {
      title: 'Поиск тикетов',
      description: 'Поиск тикетов по тексту (query; limit — сколько). JSON-массив.',
      inputSchema: { query: z.string(), limit: z.number().optional() },
    },
    async args => text(await handleSearchTickets(deps, args)),
  );

  server.registerTool(
    'get_ticket_comments',
    {
      title: 'Комментарии тикета',
      description: 'Тред комментариев тикета (диалог поддержки) по id. JSON-массив.',
      inputSchema: { id: z.number() },
    },
    async args => text(await handleGetTicketComments(deps, args)),
  );

  server.registerTool(
    'add_ticket_comment',
    {
      title: 'Ответить в тикет',
      description:
        'Добавляет комментарий в тред тикета (id, body). Тело помечается скрытым маркером бота. ' +
        'JSON созданного комментария.',
      inputSchema: { id: z.number(), body: z.string() },
    },
    async args => text(await handleAddTicketComment(deps, args)),
  );

  return server;
}
