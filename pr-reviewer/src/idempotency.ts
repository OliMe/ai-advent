import type { InlineComment } from './platform.ts';

/**
 * Скрытый маркер в теле комментария (HTML-комментарий не виден в отрендеренном markdown). По нему
 * ревьюер отличает СВОИ прежние комментарии от чужих и не дублирует их при повторных прогонах
 * (событие synchronize — новые коммиты в PR).
 */
export const AI_REVIEW_MARKER = '<!-- ai-review -->';

/** Уже существующий комментарий PR (из API): путь, строка новой версии, тело. */
export interface ExistingComment {
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
 * Ключи `путь:строка` строк, где УЖЕ есть НАШ комментарий (по маркеру). Чужие комментарии и
 * устаревшие (без актуальной строки) игнорируются — на них мы не опираемся.
 */
export function commentedLineKeys(comments: ExistingComment[]): Set<string> {
  const keys = new Set<string>();
  for (const comment of comments) {
    if (comment.line !== null && comment.body.includes(AI_REVIEW_MARKER)) {
      keys.add(`${comment.path}:${comment.line}`);
    }
  }
  return keys;
}

/**
 * Отсеивает инлайн-комментарии, которые мы уже оставляли на тех же строках (идемпотентность). Так
 * повторный прогон по новым коммитам не спамит одним и тем же замечанием. Изменилась строка — ключ
 * другой, замечание появится заново (это уместно: код под ним поменялся).
 */
export function filterAlreadyCommented(
  comments: InlineComment[],
  existingKeys: Set<string>,
): InlineComment[] {
  return comments.filter(comment => !existingKeys.has(`${comment.file}:${comment.line}`));
}
