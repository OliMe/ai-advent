/**
 * Скрытый маркер в теле комментария (HTML-комментарий не виден в отрендеренном markdown). По нему
 * ревьюер отличает СВОИ прежние комментарии от чужих и снимает их перед публикацией нового ревью,
 * чтобы повторный прогон (событие synchronize — новые коммиты в PR) не плодил дубли.
 */
export const AI_REVIEW_MARKER = '<!-- ai-review -->';

/** Уже существующий комментарий PR (из API): id, путь, строка новой версии, тело. */
export interface ExistingComment {
  id: number;
  path: string;
  /** Строка новой версии; null — устаревший комментарий (код под ним изменился). */
  line: number | null;
  body: string;
}

/** Добавляет маркер в тело комментария (в конец, отдельной строкой). */
export function markComment(body: string): string {
  return `${body}\n\n${AI_REVIEW_MARKER}`;
}

/**
 * id НАШИХ прежних комментариев (по маркеру) — их снимаем перед постингом свежего ревью. Так вместо
 * ХРУПКОГО сопоставления «та же строка» (модель приписывает тот же дефект к разной строке между
 * прогонами, а GitHub пересчитывает позиции при изменении ханка — из-за этого выходили дубли) бот
 * просто заменяет свой набор комментариев на актуальный. Чужие комментарии не трогаем.
 */
export function ownCommentIds(comments: ExistingComment[]): number[] {
  return comments
    .filter(comment => comment.body.includes(AI_REVIEW_MARKER))
    .map(comment => comment.id);
}
