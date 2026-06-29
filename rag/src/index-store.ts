import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Index } from './types.ts';

/** Хранилище индекса (сейчас JSON; за интерфейсом — позже sqlite/бинарь без правок логики). */
export interface IndexStore {
  save(index: Index): void;
  load(): Index;
}

/** JSON-хранилище индекса в одном файле (создаёт родительские каталоги при записи). */
export class JsonIndexStore implements IndexStore {
  /** Путь к файлу индекса. */
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  save(index: Index): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(index));
  }

  load(): Index {
    return JSON.parse(readFileSync(this.path, 'utf8')) as Index;
  }
}
