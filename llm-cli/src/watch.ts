import type { Writable } from 'node:stream';
import type { ToolSet } from '../../core/src/index.ts';
import { pollNewResults } from './inbox-poller.ts';

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
 */
export async function runWatch(deps: WatchDeps): Promise<void> {
  // Базовый курсор: всё, что уже есть, считаем «прочитанным» — уведомляем только о новом.
  let cursor = (await pollNewResults(deps.toolSet, '')).cursor;
  while (deps.shouldContinue()) {
    await deps.sleep(deps.intervalMs);
    const result = await pollNewResults(deps.toolSet, cursor);
    cursor = result.cursor;
    for (const run of result.runs) {
      const mark = run.ok ? '✓' : '✗';
      deps.output.write(`\n🔔 ${mark} ${run.taskTitle}: ${run.text}\n`);
      deps.notify(`Планировщик: ${run.taskTitle}`, run.text);
    }
  }
}
