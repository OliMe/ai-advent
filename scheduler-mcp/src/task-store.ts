import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { SchedulerState, Task, TaskRun } from './types.ts';

/** Хранилище состояния планировщика (задачи + история запусков). */
export interface TaskStore {
  /** Читает состояние; отсутствующий/битый файл → пустое состояние. */
  read(): SchedulerState;
  /** Атомарно сохраняет состояние. */
  write(state: SchedulerState): void;
}

/** Похоже ли разобранное значение на корректное состояние планировщика. */
function isSchedulerState(value: unknown): value is SchedulerState {
  const candidate = value as Partial<SchedulerState> | null;
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    Array.isArray(candidate.tasks) &&
    Array.isArray(candidate.runs)
  );
}

/** Пустое состояние — стартовое и фолбэк при отсутствии/повреждении файла. */
function emptyState(): SchedulerState {
  return { tasks: [] as Task[], runs: [] as TaskRun[] };
}

/** Файловое хранилище состояния: один JSON-файл с атомарной записью (tmp + rename). */
export class FileTaskStore implements TaskStore {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  read(): SchedulerState {
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch {
      return emptyState(); // файла ещё нет
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      return isSchedulerState(parsed) ? parsed : emptyState();
    } catch {
      return emptyState(); // битый JSON
    }
  }

  write(state: SchedulerState): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.path}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(temporaryPath, this.path);
  }
}
