/**
 * Защита от петли: комментарии, оставленные ботом, помечаются скрытым HTML-маркером (в отрендеренном
 * markdown он невиден). По нему ассистент отличает СВОИ ответы от реплик пользователя и не отвечает на
 * собственный комментарий (иначе `issue_comment` от бота триггерил бы бесконечный цикл). Тот же приём,
 * что идемпотентность pr-reviewer.
 */

/** Скрытый маркер комментария бота. */
export const SUPPORT_MARKER = '<!-- ai-support -->';

/** Дописывает маркер в тело комментария (в конец, отдельной строкой). */
export function markComment(body: string): string {
  return `${body}\n\n${SUPPORT_MARKER}`;
}

/** Помечен ли комментарий как ботовый (по маркеру). */
export function hasSupportMarker(body: string): boolean {
  return body.includes(SUPPORT_MARKER);
}
