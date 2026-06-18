import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { summarizeRun, type RunSummary, type TaskRun } from './task-run.ts';

/** Хранилище прогонов: список/загрузка/сохранение/удаление + файлы-артефакты. */
export interface RunStore {
  /** Сводки всех прогонов, свежие — первыми. */
  list(): RunSummary[];
  /** Загружает прогон по id или null, если его нет / файл повреждён. */
  load(id: string): TaskRun | null;
  /** Сохраняет прогон (перезаписывает существующий с тем же id). */
  save(run: TaskRun): void;
  /** Удаляет прогон и его каталог файлов-артефактов. */
  delete(id: string): void;
  /** Пишет файл-артефакт прогона (для крупных результатов execution); возвращает путь. */
  writeArtifact(runId: string, name: string, content: string): string;
}

/** Похоже ли разобранное значение на корректный прогон. */
function isRun(value: unknown): value is TaskRun {
  const candidate = value as Partial<TaskRun> | null;
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof candidate.id === 'string' &&
    typeof candidate.title === 'string' &&
    typeof candidate.stage === 'string' &&
    typeof candidate.artifacts === 'object'
  );
}

const JSON_SUFFIX = '.json';

/**
 * Файловое хранилище: `<id>.json` на прогон в каталоге + подкаталог `<id>/` для
 * крупных файлов-артефактов (результаты execution).
 */
export class FileRunStore implements RunStore {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  private pathFor(id: string): string {
    return join(this.directory, `${id}${JSON_SUFFIX}`);
  }

  private artifactDir(id: string): string {
    return join(this.directory, id);
  }

  load(id: string): TaskRun | null {
    let raw: string;
    try {
      raw = readFileSync(this.pathFor(id), 'utf8');
    } catch {
      return null; // файла нет
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      return isRun(parsed) ? parsed : null;
    } catch {
      return null; // битый JSON — считаем прогон отсутствующим
    }
  }

  save(run: TaskRun): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.pathFor(run.id)}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(run, null, 2), { mode: 0o600 });
    renameSync(temporaryPath, this.pathFor(run.id));
  }

  delete(id: string): void {
    rmSync(this.pathFor(id), { force: true });
    rmSync(this.artifactDir(id), { recursive: true, force: true });
  }

  writeArtifact(runId: string, name: string, content: string): string {
    const dir = this.artifactDir(runId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, name);
    writeFileSync(path, content, { mode: 0o600 });
    return path;
  }

  list(): RunSummary[] {
    let files: string[];
    try {
      files = readdirSync(this.directory);
    } catch {
      return []; // каталога ещё нет
    }
    const summaries: RunSummary[] = [];
    for (const file of files) {
      if (!file.endsWith(JSON_SUFFIX)) {
        continue;
      }
      const run = this.load(file.slice(0, -JSON_SUFFIX.length));
      if (run !== null) {
        summaries.push(summarizeRun(run));
      }
    }
    summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return summaries;
  }
}
