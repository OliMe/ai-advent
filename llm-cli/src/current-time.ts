/** Форматирует смещение пояса (минуты восточнее UTC) как ±HH:MM. */
export function formatTzOffset(offsetMinutesEast: number): string {
  const sign = offsetMinutesEast < 0 ? '-' : '+';
  const absolute = Math.abs(offsetMinutesEast);
  const hours = String(Math.floor(absolute / 60)).padStart(2, '0');
  const minutes = String(absolute % 60).padStart(2, '0');
  return `${sign}${hours}:${minutes}`;
}

/**
 * Подсказка с текущим временем и часовым поясом для агента: чтобы он переводил относительные
 * сроки («завтра», «в пятницу», «через 2 часа») в абсолютные при постановке задач планировщику.
 */
export function currentTimeContext(now: Date): string {
  const offsetEast = -now.getTimezoneOffset();
  return (
    `Текущее время (UTC): ${now.toISOString()}; часовой пояс пользователя — UTC` +
    `${formatTzOffset(offsetEast)} (tzOffsetMinutes=${offsetEast}). Используй это, чтобы ` +
    'переводить относительные сроки («завтра», «в пятницу», «через 2 часа») в абсолютные ' +
    'значения при постановке задач планировщику.'
  );
}
