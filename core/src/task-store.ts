import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { sessionId } from './session.ts';

/** Версия формата файла задачи — для будущих миграций. */
export const TASK_VERSION = 1;

/** Состояние задачи: активная или завершённая. */
export type TaskStatus = 'active' | 'done';

/** Задача пользователя: переживает сессии, пока не закрыта. */
export interface Task {
  version: number;
  id: string;
  /** Короткое имя задачи (для списка и переключения). */
  title: string;
  status: TaskStatus;
  /** Факты задачи: цель, ограничения, решения, прогресс. */
  details: string[];
  createdAt: string;
  updatedAt: string;
}

/** Короткая сводка задачи для списка — без полного содержимого. */
export interface TaskSummary {
  id: string;
  title: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  detailCount: number;
}

/** Хранилище задач: список, загрузка, сохранение. */
export interface TaskStore {
  /** Сводки всех задач, свежие — первыми. */
  list(): TaskSummary[];
  /** Загружает задачу по id или null, если её нет / файл повреждён. */
  load(id: string): Task | null;
  /** Сохраняет задачу (перезаписывает существующую с тем же id). */
  save(task: Task): void;
  /** Удаляет задачу по id (молча, если её нет). */
  delete(id: string): void;
}

/** Случайный суффикс id (6 hex-символов). */
function randomSuffix(): string {
  return randomBytes(3).toString('hex');
}

/** Создаёт новую активную задачу с заданными именем и деталями. */
export function createTask(
  title: string,
  details: string[] = [],
  now: Date = new Date(),
  idSuffix: string = randomSuffix(),
): Task {
  const timestamp = now.toISOString();
  return {
    version: TASK_VERSION,
    id: sessionId(now, idSuffix),
    title,
    status: 'active',
    details,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/** Строит сводку задачи для списка. */
export function summarizeTask(task: Task): TaskSummary {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    detailCount: task.details.length,
  };
}

/** Похоже ли разобранное значение на корректную задачу. */
function isTask(value: unknown): value is Task {
  const candidate = value as Partial<Task> | null;
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof candidate.id === 'string' &&
    typeof candidate.title === 'string' &&
    Array.isArray(candidate.details)
  );
}

const JSON_SUFFIX = '.json';

/** Файловое хранилище: по файлу `<id>.json` на задачу в заданном каталоге. */
export class FileTaskStore implements TaskStore {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  private pathFor(id: string): string {
    return join(this.directory, `${id}${JSON_SUFFIX}`);
  }

  load(id: string): Task | null {
    let raw: string;
    try {
      raw = readFileSync(this.pathFor(id), 'utf8');
    } catch {
      return null; // файла нет или нет доступа
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      return isTask(parsed) ? parsed : null;
    } catch {
      return null; // битый JSON — считаем задачу отсутствующей
    }
  }

  save(task: Task): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    // Атомарно: пишем во временный файл и переименовываем поверх целевого.
    const temporaryPath = `${this.pathFor(task.id)}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(task, null, 2), { mode: 0o600 });
    renameSync(temporaryPath, this.pathFor(task.id));
  }

  delete(id: string): void {
    rmSync(this.pathFor(id), { force: true }); // force — не падаем, если файла нет
  }

  list(): TaskSummary[] {
    let files: string[];
    try {
      files = readdirSync(this.directory);
    } catch {
      return []; // каталога ещё нет
    }
    const summaries: TaskSummary[] = [];
    for (const file of files) {
      if (!file.endsWith(JSON_SUFFIX)) {
        continue;
      }
      const task = this.load(file.slice(0, -JSON_SUFFIX.length));
      if (task !== null) {
        summaries.push(summarizeTask(task));
      }
    }
    // Сортируем по времени обновления: самые свежие — первыми.
    summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return summaries;
  }
}
