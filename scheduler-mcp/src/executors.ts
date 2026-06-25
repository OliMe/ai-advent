import type { Task, TaskKind, TaskRun } from './types.ts';
import { collectSystemMetrics, type SystemReaders } from './system-metrics.ts';
import { aggregateMetrics, formatReport } from './aggregate.ts';

/** Минимальный ответ HTTP, нужный исполнителям (json — для чтения /metrics). */
export interface HttpResponseLike {
  status: number;
  ok: boolean;
  json?(): Promise<unknown>;
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

/** Зависимости исполнителей: HTTP-клиент, часы, (опц.) LLM-раннер, источники метрик и история. */
export interface ExecutorDeps {
  fetchFn: FetchLike;
  now: () => number;
  agentRunner?: AgentRunner;
  /** Источники системных метрик для kind=system_metrics. */
  systemReaders?: SystemReaders;
  /** Доступ к истории запусков задачи для kind=report. */
  history?: (taskId: string) => TaskRun[];
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
    system_metrics: async task => {
      if (deps.systemReaders === undefined) {
        return { ok: false, summary: 'сбор метрик не настроен на сервере.', details: {} };
      }
      const metrics = collectSystemMetrics(deps.systemReaders);
      const details: Record<string, unknown> = { ...metrics };
      let availabilityNote = '';
      if (task.url) {
        const startedAt = deps.now();
        try {
          const response = await deps.fetchFn(task.url, { method: 'GET' });
          details.available = response.ok;
          details.latencyMs = deps.now() - startedAt;
          availabilityNote = `, ${task.url} ${response.ok ? 'ok' : 'down'}`;
        } catch (error) {
          details.available = false;
          details.latencyMs = deps.now() - startedAt;
          details.error = errorMessage(error);
          availabilityNote = `, ${task.url} недоступен`;
        }
      }
      if (task.metricsUrl) {
        try {
          const response = await deps.fetchFn(task.metricsUrl, { method: 'GET' });
          const data = (await response.json?.()) as { requests?: unknown } | undefined;
          if (data !== undefined && typeof data.requests === 'number') {
            details.requests = data.requests;
          }
        } catch {
          // метрики недоступны — пропускаем
        }
      }
      return {
        ok: true,
        summary:
          `RAM ${metrics.memoryUsedPercent}%, CPU ${metrics.cpuLoadPercent}%, ` +
          `диск своб ${metrics.diskFreePercent}%${availabilityNote}`,
        details,
      };
    },
    report: async task => {
      const runs = deps.history === undefined ? [] : deps.history(task.targetTaskId ?? '');
      const aggregate = aggregateMetrics(runs);
      return {
        ok: true,
        summary: `отчёт: ${aggregate.count} замер(ов)`,
        details: { text: formatReport(aggregate) },
      };
    },
  };
}
