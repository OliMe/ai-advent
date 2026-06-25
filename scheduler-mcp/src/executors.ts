import type { Task, TaskKind } from './types.ts';

/** Минимальный ответ HTTP, нужный исполнителю http_check. */
export interface HttpResponseLike {
  status: number;
  ok: boolean;
}

/** Функция HTTP-запроса (шов для тестов; реальная — глобальный fetch). */
export type FetchLike = (url: string, init?: { method?: string }) => Promise<HttpResponseLike>;

/** Результат одного исполнения задачи. */
export interface RunOutcome {
  ok: boolean;
  summary: string;
  details: Record<string, unknown>;
}

/** Исполнитель одной задачи. */
export type Executor = (task: Task) => Promise<RunOutcome>;

/** Зависимости исполнителей: HTTP-клиент и часы (для латентности). */
export interface ExecutorDeps {
  fetchFn: FetchLike;
  now: () => number;
}

/** Текст ошибки из неизвестного значения. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Собирает набор исполнителей по типам задач. http_check пингует URL и меряет латентность
 * (доступность = response.ok); note просто возвращает свой текст (напоминание/заметка).
 */
export function makeExecutors(deps: ExecutorDeps): Record<TaskKind, Executor> {
  return {
    http_check: async task => {
      const url = task.url ?? '';
      const startedAt = deps.now();
      try {
        const response = await deps.fetchFn(url, { method: 'GET' });
        const latencyMs = deps.now() - startedAt;
        return {
          ok: response.ok,
          summary: `HTTP ${response.status} за ${latencyMs} мс`,
          details: { status: response.status, ok: response.ok, latencyMs },
        };
      } catch (error) {
        const latencyMs = deps.now() - startedAt;
        return {
          ok: false,
          summary: `недоступен: ${errorMessage(error)}`,
          details: { error: errorMessage(error), latencyMs },
        };
      }
    },
    note: async task => ({
      ok: true,
      summary: task.text ?? '',
      details: {},
    }),
  };
}
