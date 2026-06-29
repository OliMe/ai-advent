import type { Writable } from 'node:stream';
import type { ToolSet } from '../../core/src/index.ts';
import { pollNewResults } from './inbox-poller.ts';
import { describeError } from './errors.ts';

/** Зависимости фонового наблюдателя за инбоксом планировщика. */
export interface WatchDeps {
  /** Набор инструментов с poll_results (обычно McpToolSet). */
  toolSet: ToolSet;
  /** Куда печатать пришедшие результаты. */
  output: Writable;
  /** Показать системное уведомление. */
  notify: (title: string, message: string) => void;
  /** Пауза между опросами. */
  sleep: (ms: number) => Promise<void>;
  /** Интервал опроса, мс. */
  intervalMs: number;
  /** Продолжать ли цикл (false — выйти; для остановки по Ctrl+C/в тестах). */
  shouldContinue: () => boolean;
  /** Источник текущего времени (для меток в логе; инжектируется для тестов). */
  now: () => Date;
}

/** Двузначное число с ведущим нулём. */
function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** Ярлык часового пояса по смещению в минутах от UTC (+300 → «UTC+5», -210 → «UTC-3:30»). */
export function tzLabel(offsetMinutes: number): string {
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutes);
  const hours = Math.floor(absolute / 60);
  const minutes = absolute % 60;
  return `UTC${sign}${hours}${minutes ? `:${pad2(minutes)}` : ''}`;
}

/** Локальная метка «ДД.ММ ЧЧ:ММ:СС UTC±H» из даты (часовой пояс машины — пояс пользователя). */
function stampDate(date: Date): string {
  return (
    `${pad2(date.getDate())}.${pad2(date.getMonth() + 1)} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())} ` +
    tzLabel(-date.getTimezoneOffset())
  );
}

/** Метка времени из ISO-строки `firedAt`; если это не дата — отдаём как есть. */
function stampIso(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : stampDate(date);
}

/**
 * Фоновый наблюдатель: на старте берёт базовый курсор (текущие результаты не шумят), затем
 * периодически опрашивает планировщик и для каждого нового запуска печатает строку и шлёт
 * системное уведомление. Каждая строка лога помечается датой/временем (`[ДД.ММ ЧЧ:ММ:СС]`):
 * у уведомлений — фактическое время срабатывания (`firedAt`), у ошибок — текущее. Работает,
 * пока shouldContinue возвращает true.
 *
 * Устойчивость: сбой опроса (таймаут MCP/сеть) НЕ роняет наблюдатель — он логируется и
 * повторяется на следующем интервале. Иначе единичный таймаут (например, на старте) обрывал
 * слежение, и утренние уведомления не приходили. Если базовый курсор не удалось взять сразу,
 * первый успешный опрос становится базовым (о старых запусках не шумим).
 */
export async function runWatch(deps: WatchDeps): Promise<void> {
  let cursor = '';
  let baselineEstablished = false;
  // Базовый курсор: всё, что уже есть, считаем «прочитанным». Сбой здесь не фатален — возьмём
  // базовый курсор на первом успешном опросе в цикле.
  try {
    cursor = (await pollNewResults(deps.toolSet, '')).cursor;
    baselineEstablished = true;
  } catch (error) {
    deps.output.write(
      `\n⚠ [${stampDate(deps.now())}] не удалось взять базовый курсор планировщика: ` +
        `${describeError(error)} (повторю при опросе)\n`,
    );
  }
  while (deps.shouldContinue()) {
    await deps.sleep(deps.intervalMs);
    try {
      const result = await pollNewResults(deps.toolSet, cursor);
      cursor = result.cursor;
      if (!baselineEstablished) {
        baselineEstablished = true; // первый успех после сбоя базового — это базовый, не шумим
        continue;
      }
      for (const run of result.runs) {
        const mark = run.ok ? '✓' : '✗';
        deps.output.write(
          `\n🔔 [${stampIso(run.firedAt)}] ${mark} ${run.taskTitle}: ${run.text}\n`,
        );
        deps.notify(`Планировщик: ${run.taskTitle}`, run.text);
      }
    } catch (error) {
      // Транзиентный сбой опроса не должен ронять наблюдатель — логируем и повторим позже.
      deps.output.write(
        `\n⚠ [${stampDate(deps.now())}] опрос планировщика не удался: ${describeError(error)}\n`,
      );
    }
  }
}
