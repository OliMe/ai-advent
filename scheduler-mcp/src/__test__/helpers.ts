import { Scheduler } from '../index.ts';
import type { DeliverFn, Executor, SchedulerState, TaskKind, TaskStore } from '../index.ts';

/** Хранилище состояния в памяти (для тестов). */
export function memoryStore(initial?: SchedulerState): {
  store: TaskStore;
  current: () => SchedulerState;
} {
  let state: SchedulerState = initial ?? { tasks: [], runs: [] };
  return {
    store: {
      read: () => state,
      write: updated => {
        state = updated;
      },
    },
    current: () => state,
  };
}

/** Управляемые часы для детерминированных тестов. */
export function fixedClock(start = 1_000): {
  now: () => number;
  set: (value: number) => void;
  advance: (delta: number) => void;
} {
  let current = start;
  return {
    now: () => current,
    set: value => {
      current = value;
    },
    advance: delta => {
      current += delta;
    },
  };
}

/** Генератор последовательных идентификаторов. */
export function counterIds(prefix = 'id'): () => string {
  let counter = 0;
  return () => `${prefix}${++counter}`;
}

/** Тривиальные исполнители: всегда успех (note возвращает свой текст). */
export function trivialExecutors(): Record<TaskKind, Executor> {
  return {
    http_check: async () => ({ ok: true, summary: 'ok', details: {} }),
    note: async task => ({ ok: true, summary: task.text ?? '', details: {} }),
    agent: async task => ({ ok: true, summary: `agent: ${task.instruction ?? ''}`, details: {} }),
  };
}

/** Собирает движок с переданными (или дефолтными) зависимостями. */
export function makeScheduler(
  options: {
    store?: TaskStore;
    executors?: Record<TaskKind, Executor>;
    now?: () => number;
    idFactory?: () => string;
    deliver?: DeliverFn;
  } = {},
): Scheduler {
  return new Scheduler({
    store: options.store ?? memoryStore().store,
    executors: options.executors ?? trivialExecutors(),
    now: options.now ?? fixedClock().now,
    idFactory: options.idFactory ?? counterIds(),
    deliver: options.deliver,
  });
}
