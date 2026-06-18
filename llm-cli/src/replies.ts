/** Разбирает список значений через запятую, обрезая пробелы и пустые. */
export function parseList(raw: string): string[] {
  return raw
    .split(',')
    .map(token => token.trim())
    .filter(token => token.length > 0);
}

/** Утвердительный ли ответ пользователя (да/yes/…). */
export function isAffirmative(reply: string): boolean {
  return ['да', 'yes', 'y', 'ага', 'давай', 'ок', 'ok', 'д'].includes(reply);
}

/** Отрицательный ли ответ пользователя (нет/no/…). */
export function isNegative(reply: string): boolean {
  return ['нет', 'no', 'n', 'не', 'н'].includes(reply);
}
