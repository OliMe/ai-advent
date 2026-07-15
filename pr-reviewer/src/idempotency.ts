/**
 * Скрытый маркер в теле комментария (HTML-комментарий не виден в отрендеренном markdown). По нему
 * ревьюер отличает СВОИ прежние комментарии от чужих: инлайн-комментарии снимает и ставит заново, а
 * сводку (issue-комментарий) обновляет на месте — чтобы повторный прогон (событие synchronize) не
 * плодил ни дублей у строк, ни стопки «reviewed»-сводок.
 */
export const AI_REVIEW_MARKER = '<!-- ai-review -->';

/** Комментарий PR из API: id и тело (для распознавания своих по маркеру и снятия/обновления). */
export interface ApiComment {
  id: number;
  body: string;
}

/** Добавляет маркер в тело комментария (в конец, отдельной строкой). */
export function markComment(body: string): string {
  return `${body}\n\n${AI_REVIEW_MARKER}`;
}

/** Наш ли это комментарий (по маркеру). */
export function hasAiMarker(body: string): boolean {
  return body.includes(AI_REVIEW_MARKER);
}

/** id НАШИХ комментариев (по маркеру) среди списка — их снимаем/обновляем. Чужие не трогаем. */
export function ownCommentIds(comments: ApiComment[]): number[] {
  return comments.filter(comment => hasAiMarker(comment.body)).map(comment => comment.id);
}
