import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

/** Версия формата файла профиля — для будущих миграций. */
export const PROFILE_VERSION = 1;

/** Имя профиля по умолчанию. */
export const DEFAULT_PROFILE_NAME = 'default';

/** Один факт о пользователе (для долговременной памяти). */
export interface ProfileEntry {
  /** Короткая формулировка, напр. «предпочитает краткие ответы с кодом». */
  text: string;
  updatedAt: string;
}

/** Долговременный профиль пользователя (персона): накапливается между сессиями. */
export interface Profile {
  version: number;
  /** Имя профиля (персоны), напр. «default», «работа». */
  name: string;
  entries: ProfileEntry[];
  updatedAt: string;
}

/** Короткая сводка профиля для списка. */
export interface ProfileSummary {
  name: string;
  entryCount: number;
  updatedAt: string;
}

/** Хранилище профилей: список, загрузка/сохранение по имени, активный профиль. */
export interface ProfileStore {
  /** Сводки всех профилей, свежие — первыми. */
  list(): ProfileSummary[];
  /** Загружает профиль по имени; если файла нет/повреждён — пустой именованный. */
  load(name: string): Profile;
  /** Сохраняет профиль (файл по его имени). */
  save(profile: Profile): void;
  /** Имя активного профиля (по умолчанию «default»). */
  activeName(): string;
  /** Задаёт активный профиль. */
  setActive(name: string): void;
}

/** Пустой профиль с заданным именем (холодный старт). */
export function emptyProfile(name: string = DEFAULT_PROFILE_NAME, now: Date = new Date()): Profile {
  return { version: PROFILE_VERSION, name, entries: [], updatedAt: now.toISOString() };
}

/** Строит сводку профиля для списка. */
export function summarizeProfile(profile: Profile): ProfileSummary {
  return { name: profile.name, entryCount: profile.entries.length, updatedAt: profile.updatedAt };
}

/**
 * Похоже ли разобранное значение на профиль (есть массив entries). Имя и время
 * при загрузке подставляются вызывающим (имя файла — источник истины).
 */
function isProfile(value: unknown): value is Profile {
  const candidate = value as Partial<Profile> | null;
  return typeof candidate === 'object' && candidate !== null && Array.isArray(candidate.entries);
}

const JSON_SUFFIX = '.json';
/** Имя файла с указателем активного профиля (без .json, поэтому list его пропускает). */
const ACTIVE_FILE = '.active';

/** Файловое хранилище профилей: каталог с файлом на профиль + указатель активного. */
export class FileProfileStore implements ProfileStore {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  // Имя кодируем в имя файла — так любое имя (с пробелами/кириллицей) безопасно и обратимо.
  private pathFor(name: string): string {
    return join(this.directory, `${encodeURIComponent(name)}${JSON_SUFFIX}`);
  }

  load(name: string): Profile {
    let raw: string;
    try {
      raw = readFileSync(this.pathFor(name), 'utf8');
    } catch {
      return emptyProfile(name); // профиля ещё нет
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isProfile(parsed)) {
        return emptyProfile(name);
      }
      // Имя берём из запрошенного (имя файла — источник истины).
      return {
        version: PROFILE_VERSION,
        name,
        entries: parsed.entries,
        updatedAt: parsed.updatedAt,
      };
    } catch {
      return emptyProfile(name); // битый JSON — пустой профиль
    }
  }

  save(profile: Profile): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.pathFor(profile.name)}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(profile, null, 2), { mode: 0o600 });
    renameSync(temporaryPath, this.pathFor(profile.name));
  }

  list(): ProfileSummary[] {
    let files: string[];
    try {
      files = readdirSync(this.directory);
    } catch {
      return []; // каталога ещё нет
    }
    const summaries: ProfileSummary[] = [];
    for (const file of files) {
      if (!file.endsWith(JSON_SUFFIX)) {
        continue;
      }
      summaries.push(
        summarizeProfile(this.load(decodeURIComponent(file.slice(0, -JSON_SUFFIX.length)))),
      );
    }
    summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return summaries;
  }

  activeName(): string {
    try {
      return readFileSync(join(this.directory, ACTIVE_FILE), 'utf8').trim() || DEFAULT_PROFILE_NAME;
    } catch {
      return DEFAULT_PROFILE_NAME; // указателя ещё нет
    }
  }

  setActive(name: string): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    writeFileSync(join(this.directory, ACTIVE_FILE), name, { mode: 0o600 });
  }

  /**
   * Однократная миграция старого одиночного `profile.json` в профиль «default».
   * Если «default» уже есть — ничего не делает; старый файл после импорта удаляется.
   */
  migrateLegacy(legacyPath: string): void {
    let raw: string;
    try {
      raw = readFileSync(legacyPath, 'utf8');
    } catch {
      return; // легаси-файла нет — мигрировать нечего
    }
    try {
      readFileSync(this.pathFor(DEFAULT_PROFILE_NAME), 'utf8');
      return; // профиль default уже существует — не трогаем
    } catch {
      // default ещё нет — продолжаем миграцию
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // битый легаси — оставляем как есть
    }
    if (!isProfile(parsed)) {
      return;
    }
    this.save({
      version: PROFILE_VERSION,
      name: DEFAULT_PROFILE_NAME,
      entries: parsed.entries,
      updatedAt: parsed.updatedAt,
    });
    rmSync(legacyPath, { force: true });
  }
}
