import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

/** Версия формата файла профиля — для будущих миграций. */
export const PROFILE_VERSION = 1;

/** Один факт о пользователе (для долговременной памяти). */
export interface ProfileEntry {
  /** Короткая формулировка, напр. «предпочитает краткие ответы с кодом». */
  text: string;
  updatedAt: string;
}

/** Долговременный профиль пользователя: накапливается между сессиями. */
export interface Profile {
  version: number;
  entries: ProfileEntry[];
  updatedAt: string;
}

/** Хранилище профиля: один глобальный файл (CLI однопользовательский). */
export interface ProfileStore {
  /** Загружает профиль; если файла нет/повреждён — пустой профиль. */
  load(): Profile;
  /** Сохраняет профиль (перезаписывает файл целиком). */
  save(profile: Profile): void;
}

/** Пустой профиль (холодный старт). */
export function emptyProfile(now: Date = new Date()): Profile {
  return { version: PROFILE_VERSION, entries: [], updatedAt: now.toISOString() };
}

/** Похоже ли разобранное значение на корректный профиль. */
function isProfile(value: unknown): value is Profile {
  const candidate = value as Partial<Profile> | null;
  return typeof candidate === 'object' && candidate !== null && Array.isArray(candidate.entries);
}

/** Файловое хранилище профиля: один JSON-файл по заданному пути. */
export class FileProfileStore implements ProfileStore {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  load(): Profile {
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch {
      return emptyProfile(); // файла ещё нет
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      return isProfile(parsed) ? parsed : emptyProfile();
    } catch {
      return emptyProfile(); // битый JSON — считаем профиль пустым
    }
  }

  save(profile: Profile): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    // Атомарно: пишем во временный файл и переименовываем поверх целевого.
    const temporaryPath = `${this.path}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(profile, null, 2), { mode: 0o600 });
    renameSync(temporaryPath, this.path);
  }
}
