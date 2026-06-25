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

/** Раннер LLM-инструкции (server-side агент); реализуется поверх core.Conversation. */
export interface AgentRunner {
  /** Исполняет инструкцию на естественном языке и возвращает финальный текст. */
  run(instruction: string): Promise<string>;
}

/** Зависимости исполнителей: HTTP-клиент, часы и (опц.) LLM-раннер для kind=agent. */
export interface ExecutorDeps {
  fetchFn: FetchLike;
  now: () => number;
  agentRunner?: AgentRunner;
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
    agent: async task => {
      if (deps.agentRunner === undefined) {
        return {
          ok: false,
          summary: 'LLM-исполнитель не настроен на сервере (нет LLM_* в .env).',
          details: {},
        };
      }
      try {
        const text = await deps.agentRunner.run(task.instruction ?? '');
        return { ok: true, summary: text.split('\n')[0], details: { text } };
      } catch (error) {
        return {
          ok: false,
          summary: `ошибка исполнения: ${errorMessage(error)}`,
          details: { error: errorMessage(error) },
        };
      }
    },
  };
}
