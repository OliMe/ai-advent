import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
  statSync,
  existsSync,
  rmSync,
  rmdirSync,
} from 'node:fs';
import { dirname } from 'node:path';

/** Запись каталога. */
export interface DirEntry {
  name: string;
  kind: 'file' | 'dir';
}

/** Низкоуровневые ФС-операции (шов для тестов; реальные — поверх node:fs). */
export interface FsIo {
  read(path: string): string;
  write(path: string, content: string): void;
  append(path: string, content: string): void;
  list(path: string): DirEntry[];
  /** Тип объекта по пути или null, если его нет. */
  stat(path: string): 'file' | 'dir' | null;
  removeFile(path: string): void;
  removeEmptyDir(path: string): void;
}

/** Реальная реализация поверх node:fs (write/append создают родительские каталоги). */
export const nodeFsIo: FsIo = {
  read: path => readFileSync(path, 'utf8'),
  write: (path, content) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  },
  append: (path, content) => {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, content);
  },
  list: path =>
    readdirSync(path, { withFileTypes: true }).map(entry => ({
      name: entry.name,
      kind: entry.isDirectory() ? 'dir' : 'file',
    })),
  stat: path => (existsSync(path) ? (statSync(path).isDirectory() ? 'dir' : 'file') : null),
  removeFile: path => rmSync(path),
  removeEmptyDir: path => rmdirSync(path),
};
