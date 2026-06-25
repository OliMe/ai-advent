import type { Schedule } from './types.ts';

/** Миллисекунд в сутках. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** Проверяет корректность строки времени «HH:MM» (24-часовой формат). */
function isValidTimeOfDay(at: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(at);
}

/**
 * Проверяет расписание на осмысленность; бросает Error с понятным сообщением при ошибке.
 * Вызывается при создании задачи (до постановки в план).
 */
export function validateSchedule(schedule: Schedule): void {
  if (schedule.type === 'interval') {
    if (!Number.isInteger(schedule.everySeconds) || schedule.everySeconds < 1) {
      throw new Error('Интервал everySeconds должен быть целым числом ≥ 1 (секунды).');
    }
    return;
  }
  if (schedule.type === 'daily') {
    if (!isValidTimeOfDay(schedule.at)) {
      throw new Error('Время daily.at должно быть в формате HH:MM (например 08:00).');
    }
    if (!Number.isInteger(schedule.tzOffsetMinutes) || Math.abs(schedule.tzOffsetMinutes) > 900) {
      throw new Error('Смещение tzOffsetMinutes должно быть целым в пределах ±900 минут.');
    }
    return;
  }
  if (Number.isNaN(Date.parse(schedule.atIso))) {
    throw new Error('Момент once.atIso должен быть корректной датой ISO.');
  }
}

/** Следующее срабатывание ежедневного расписания строго после fromMs (в epoch-мс). */
function nextDaily(fromMs: number, at: string, tzOffsetMinutes: number): number {
  const [hours, minutes] = at.split(':').map(Number);
  const offsetMs = tzOffsetMinutes * 60_000;
  // Сдвигаем в «локальное» время пояса, чтобы взять его календарную дату.
  const local = new Date(fromMs + offsetMs);
  let target =
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hours, minutes) -
    offsetMs;
  if (target <= fromMs) {
    target += DAY_MS;
  }
  return target;
}

/**
 * Момент следующего срабатывания (epoch-мс) относительно fromMs. Для interval — fromMs плюс
 * интервал; для daily — ближайшее HH:MM после fromMs в нужном поясе; для once — заданный момент
 * (мог уже наступить — сработает на ближайшем тике, после чего задача завершается движком).
 */
export function nextFireTime(schedule: Schedule, fromMs: number): number {
  if (schedule.type === 'interval') {
    return fromMs + schedule.everySeconds * 1000;
  }
  if (schedule.type === 'daily') {
    return nextDaily(fromMs, schedule.at, schedule.tzOffsetMinutes);
  }
  return Date.parse(schedule.atIso);
}
