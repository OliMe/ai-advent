import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { summarize, type Session, type SessionSummary } from './session.ts';

/** Хранилище сессий: список, загрузка, сохранение, последняя по времени. */
export interface SessionStore {
  /** Сводки всех сессий, свежие — первыми. */
  list(): SessionSummary[];
  /** Загружает сессию по id или null, если её нет / файл повреждён. */
  load(id: string): Session | null;
  /** Сохраняет сессию (перезаписывает существующую с тем же id). */
  save(session: Session): void;
  /** Последняя обновлённая сессия или null, если сессий нет. */
  latest(): Session | null;
}

/** Похоже ли разобранное значение на корректную сессию. */
function isSession(value: unknown): value is Session {
  const candidate = value as Partial<Session> | null;
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof candidate.id === 'string' &&
    Array.isArray(candidate.messages)
  );
}

const JSON_SUFFIX = '.json';

/** Файловое хранилище: по файлу `<id>.json` на сессию в заданном каталоге. */
export class FileSessionStore implements SessionStore {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  private pathFor(id: string): string {
    return join(this.directory, `${id}${JSON_SUFFIX}`);
  }

  load(id: string): Session | null {
    let raw: string;
    try {
      raw = readFileSync(this.pathFor(id), 'utf8');
    } catch {
      return null; // файла нет или нет доступа
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      return isSession(parsed) ? parsed : null;
    } catch {
      return null; // битый JSON — считаем сессию отсутствующей
    }
  }

  save(session: Session): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    // Атомарно: пишем во временный файл и переименовываем поверх целевого.
    const temporaryPath = `${this.pathFor(session.id)}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(session, null, 2), { mode: 0o600 });
    renameSync(temporaryPath, this.pathFor(session.id));
  }

  list(): SessionSummary[] {
    let files: string[];
    try {
      files = readdirSync(this.directory);
    } catch {
      return []; // каталога ещё нет
    }
    const summaries: SessionSummary[] = [];
    for (const file of files) {
      if (!file.endsWith(JSON_SUFFIX)) {
        continue;
      }
      const session = this.load(file.slice(0, -JSON_SUFFIX.length));
      if (session !== null) {
        summaries.push(summarize(session));
      }
    }
    // Сортируем по времени обновления: самые свежие — первыми.
    summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return summaries;
  }

  latest(): Session | null {
    const summaries = this.list();
    return summaries.length > 0 ? this.load(summaries[0].id) : null;
  }
}
