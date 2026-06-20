import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

/** Версия формата файла инвариантов — для будущих миграций. */
export const INVARIANTS_VERSION = 1;

/**
 * Глобальные инварианты проекта: жёсткие ограничения (архитектура, техрешения,
 * стек, бизнес-правила), которые ассистент не имеет права нарушать. Хранятся
 * отдельно от диалога, действуют во всех сессиях и задачах.
 */
export interface InvariantsFile {
  version: number;
  invariants: string[];
  updatedAt: string;
}

/** Хранилище инвариантов: загрузка и сохранение единого глобального списка. */
export interface InvariantsStore {
  /** Текущий список инвариантов (пустой, если файла нет / он повреждён). */
  load(): string[];
  /** Сохраняет список инвариантов (атомарно). */
  save(invariants: string[]): void;
}

/** Похоже ли разобранное значение на файл инвариантов (есть массив строк). */
function isInvariantsFile(value: unknown): value is InvariantsFile {
  const candidate = value as Partial<InvariantsFile> | null;
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    Array.isArray(candidate.invariants) &&
    candidate.invariants.every(item => typeof item === 'string')
  );
}

/** Файловое хранилище инвариантов: единый файл `<path>` с атомарной записью. */
export class FileInvariantsStore implements InvariantsStore {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  load(): string[] {
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch {
      return []; // файла ещё нет
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      return isInvariantsFile(parsed) ? parsed.invariants : [];
    } catch {
      return []; // битый JSON — считаем, что инвариантов нет
    }
  }

  save(invariants: string[]): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const file: InvariantsFile = {
      version: INVARIANTS_VERSION,
      invariants,
      updatedAt: new Date().toISOString(),
    };
    const temporaryPath = `${this.path}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(file, null, 2), { mode: 0o600 });
    renameSync(temporaryPath, this.path);
  }
}
