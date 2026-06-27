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
}

/**
 * Фоновый наблюдатель: на старте берёт базовый курсор (текущие результаты не шумят), затем
 * периодически опрашивает планировщик и для каждого нового запуска печатает строку и шлёт
 * системное уведомление. Работает, пока shouldContinue возвращает true.
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
      `\n⚠ не удалось взять базовый курсор планировщика: ${describeError(error)} (повторю при опросе)\n`,
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
        deps.output.write(`\n🔔 ${mark} ${run.taskTitle}: ${run.text}\n`);
        deps.notify(`Планировщик: ${run.taskTitle}`, run.text);
      }
    } catch (error) {
      // Транзиентный сбой опроса не должен ронять наблюдатель — логируем и повторим позже.
      deps.output.write(`\n⚠ опрос планировщика не удался: ${describeError(error)}\n`);
    }
  }
}
