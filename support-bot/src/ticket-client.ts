import type { ToolSet } from '../../core/src/index.ts';
import type { Ticket, TicketComment } from '../../support-mcp/src/index.ts';

/**
 * Детерминированный потребитель CRM через MCP: находит инструменты по суффиксу имени (устойчиво к
 * неймспейсу `сервер__инструмент`) и зовёт их в фиксированном порядке. Никакого агентного цикла —
 * инструменты вызываем МЫ, не модель.
 */

/** Ищет инструмент, чьё имя оканчивается суффиксом; нет — ошибка (сервер не подключён). */
function findTool(toolSet: ToolSet, suffix: string): string {
  const spec = toolSet.specs().find(candidate => candidate.name.endsWith(suffix));
  if (spec === undefined) {
    throw new Error(`инструмент *${suffix} не найден — support-mcp не подключён?`);
  }
  return spec.name;
}

/** Разбирает JSON-результат инструмента; ошибка инструмента (`{error}`) или битый JSON → исключение. */
function parseJsonResult(raw: string, what: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`не удалось разобрать JSON (${what}): ${raw.slice(0, 200)}`);
  }
  if (value !== null && typeof value === 'object' && 'error' in value) {
    throw new Error(
      `инструмент вернул ошибку (${what}): ${String((value as { error: unknown }).error)}`,
    );
  }
  return value;
}

/** Читает тикет и его тред комментариев через MCP (get_ticket + get_ticket_comments). */
export async function readTicketThread(
  toolSet: ToolSet,
  id: number,
): Promise<{ ticket: Ticket; comments: TicketComment[] }> {
  const ticket = parseJsonResult(
    await toolSet.call(findTool(toolSet, 'get_ticket'), { id }),
    'get_ticket',
  ) as Ticket;
  const commentsRaw = parseJsonResult(
    await toolSet.call(findTool(toolSet, 'get_ticket_comments'), { id }),
    'get_ticket_comments',
  );
  const comments = Array.isArray(commentsRaw) ? (commentsRaw as TicketComment[]) : [];
  return { ticket, comments };
}

/** Постит ответ в тред тикета через MCP (add_ticket_comment; тело помечается маркером на сервере). */
export async function postReply(toolSet: ToolSet, id: number, body: string): Promise<void> {
  parseJsonResult(
    await toolSet.call(findTool(toolSet, 'add_ticket_comment'), { id, body }),
    'add_ticket_comment',
  );
}
