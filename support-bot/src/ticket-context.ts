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

/** Автор актуального вопроса (симметрично `pickQuestion`): последняя реплика пользователя, иначе автор тикета. */
export function pickQuestionAuthor(ticket: Ticket, comments: TicketComment[]): string {
  for (let index = comments.length - 1; index >= 0; index--) {
    if (!comments[index].isBot) {
      return comments[index].author.login;
    }
  }
  return ticket.author.login;
}

/**
 * Блочная цитата вопроса с упоминанием автора — чтобы в многолюдном обсуждении было видно, НА КАКОЙ
 * вопрос отвечает бот и КОМУ. Каждая строка вопроса идёт с `> ` (markdown-цитата), автор — `@login`
 * (адресат получит уведомление). Ставится в начало комментария бота.
 */
export function formatQuestionQuote(author: string, question: string): string {
  const quoted = question
    .split('\n')
    .map(line => `> ${line}`)
    .join('\n');
  return `> **@${author}:**\n${quoted}`;
}
