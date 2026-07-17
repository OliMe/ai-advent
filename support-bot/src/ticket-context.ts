import type { Ticket, TicketComment } from '../../support-mcp/src/index.ts';

/**
 * Контекст тикета для промпта: заголовок, автор, область (метки), описание и предыдущий диалог. Это
 * КОНТЕКСТ для подстройки ответа, а не источник знаний — отвечать всё равно по FAQ (так гейт держит
 * ответ на фактах документации, а не на репликах пользователя).
 */
export function formatTicketContext(ticket: Ticket, comments: TicketComment[]): string {
  const labels = ticket.labels.length > 0 ? ticket.labels.join(', ') : 'нет';
  const dialogue =
    comments.length === 0
      ? ''
      : `\nПредыдущий диалог:\n${comments
          .map(
            comment => `- [${comment.isBot ? 'ассистент' : comment.author.login}] ${comment.body}`,
          )
          .join('\n')}`;
  return (
    `Контекст тикета #${ticket.id}: «${ticket.title}»\n` +
    `Автор: ${ticket.author.login}\n` +
    `Область (метки): ${labels}\n` +
    `Описание: ${ticket.body}${dialogue}\n\n` +
    'Учитывай этот контекст, но ОТВЕЧАЙ по фрагментам FAQ ниже.'
  );
}

/**
 * Актуальный вопрос: последняя реплика пользователя (не бота) — на неё и отвечаем; нет реплик
 * пользователя (тикет только открыт) → описание тикета.
 */
export function pickQuestion(ticket: Ticket, comments: TicketComment[]): string {
  for (let index = comments.length - 1; index >= 0; index--) {
    if (!comments[index].isBot) {
      return comments[index].body;
    }
  }
  return ticket.body;
}
