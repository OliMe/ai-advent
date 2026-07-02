/**
 * Сборка MCP-сервера RAG: регистрирует search_docs/list_indexes/build_index. Только проводка к
 * SDK — логика в tools/retrieval/cache, поэтому файл исключён из покрытия.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolDeps } from './tools.ts';
import { handleSearchDocs, handleListIndexes, handleBuildIndex } from './tools.ts';

/** Оборачивает текст в ответ MCP-инструмента. */
function text(value: string): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: value }] };
}

/** Создаёт MCP-сервер RAG из реальных зависимостей. */
export function createServer(deps: ToolDeps): McpServer {
  const server = new McpServer({ name: 'rag-mcp', version: '1.0.0' });

  server.registerTool(
    'search_docs',
    {
      title: 'Поиск по документам (RAG)',
      description:
        'Ищет релевантные фрагменты в проиндексированных документах. Если задан source ' +
        '(ссылка на github.com / путь к папке / URL документации) — индексирует его на лету при ' +
        'отсутствии индекса, иначе ищет по уже построенным. Опц. можно переопределить порог ' +
        'релевантности (minScore), режим переранжирования (rerank: none/mmr/llm) и переписывания ' +
        'запроса (rewrite: none/expand/hyde). Возвращает фрагменты с метками источников (и трассу ' +
        'стадий) — отвечай по ним и ссылайся на источник.',
      inputSchema: {
        query: z.string(),
        source: z.string().optional(),
        strategy: z.enum(['fixed', 'structural']).optional(),
        k: z.number().optional(),
        minScore: z.number().min(0).max(1).optional(),
        rerank: z.enum(['none', 'mmr', 'llm']).optional(),
        rewrite: z.enum(['none', 'expand', 'hyde']).optional(),
      },
    },
    async args => text(await handleSearchDocs(deps, args)),
  );

  server.registerTool(
    'list_indexes',
    {
      title: 'Список индексов',
      description: 'Перечисляет уже построенные (кэшированные) индексы документов.',
      inputSchema: {},
    },
    async () => text(handleListIndexes(deps)),
  );

  server.registerTool(
    'build_index',
    {
      title: 'Построить индекс',
      description:
        'Заранее индексирует источник (github-url / путь / url документации). ' +
        'Опц. strategy (fixed/structural). Полезно, чтобы первый поиск был быстрым.',
      inputSchema: {
        source: z.string(),
        strategy: z.enum(['fixed', 'structural']).optional(),
      },
    },
    async args => text(await handleBuildIndex(deps, args)),
  );

  return server;
}
