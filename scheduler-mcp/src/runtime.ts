/**
 * Runtime-обвязка движка: сборка планировщика с реальными зависимостями (fetch, системные
 * часы, crypto-идентификаторы) и фоновый тик через setInterval. Только проводка к платформе —
 * поэтому файл исключён из покрытия (логика — в scheduler/executors/schedule/task-store).
 */
import { randomBytes } from 'node:crypto';
import { FileTaskStore } from './task-store.ts';
import { makeExecutors } from './executors.ts';
import { Scheduler } from './scheduler.ts';

/** Создаёт планировщик с файловым хранилищем и реальными зависимостями. */
export function createDefaultScheduler(storePath: string): Scheduler {
  const store = new FileTaskStore(storePath);
  const executors = makeExecutors({
    fetchFn: (url, init) => fetch(url, init),
    now: () => Date.now(),
  });
  return new Scheduler({
    store,
    executors,
    now: () => Date.now(),
    idFactory: () => randomBytes(6).toString('hex'),
  });
}

/** Запускает фоновый тик; пропускает запуск, если предыдущий ещё идёт. */
export function startTicking(scheduler: Scheduler, intervalMs: number): NodeJS.Timeout {
  let running = false;
  return setInterval(() => {
    if (running) {
      return;
    }
    running = true;
    void scheduler.tick().finally(() => {
      running = false;
    });
  }, intervalMs);
}
