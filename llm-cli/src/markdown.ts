/**
 * Лёгкий рендер базового markdown в ANSI для терминала: жирный (`**…**`/`__…__`), инлайн-код
 * (`` `…` ``) и заголовки (`#`…`######`). Модель часто форматирует ответ markdown-ом, а терминал
 * его не отрисовывает — без этого видны сырые `**`, `##`, `` ` ``. Вне TTY (пайпы/файлы/тесты)
 * возвращаем текст без изменений: там markdown как исходник уместнее и не ломает разбор вывода.
 */

/** Жирный: **текст** или __текст__. */
const BOLD = /\*\*(.+?)\*\*|__(.+?)__/g;
/** Инлайн-код: `текст`. */
const INLINE_CODE = /`([^`]+)`/g;
/** Заголовок строки: один-шесть `#`, пробел, текст (решётки убираем). */
const HEADING = /^#{1,6}[ \t]+(.*)$/gm;

/** SGR-коды: жирный/код включаем, 22 — сброс яркости (и жирного, и тусклого). */
const ANSI_BOLD = '\x1b[1m';
const ANSI_DIM = '\x1b[2m';
const ANSI_NORMAL = '\x1b[22m';

/** Рендерит базовый markdown в ANSI, если вывод — терминал; иначе отдаёт текст как есть. */
export function renderMarkdownForTerminal(text: string, isTty: boolean): string {
  if (!isTty) {
    return text;
  }
  return text
    .replace(HEADING, (_match, body) => `${ANSI_BOLD}${body}${ANSI_NORMAL}`)
    .replace(
      BOLD,
      (_match, starred, underscored) => `${ANSI_BOLD}${starred ?? underscored}${ANSI_NORMAL}`,
    )
    .replace(INLINE_CODE, (_match, code) => `${ANSI_DIM}${code}${ANSI_NORMAL}`);
}
