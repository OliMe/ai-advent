import { basename, relative } from 'node:path';
import type { Document } from '../types.ts';

/** Расширения, считаемые текстовыми (код + документация). */
const TEXT_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.rst',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.rb',
  '.c',
  '.h',
  '.cpp',
  '.cc',
  '.css',
  '.scss',
  '.html',
  '.vue',
  '.svelte',
  '.yml',
  '.yaml',
  '.toml',
  '.ini',
  '.sh',
]);

/** Текстовый ли файл (по расширению) — индексируем только код и документацию. */
export function isTextFile(path: string): boolean {
  const dot = path.lastIndexOf('.');
  return dot !== -1 && TEXT_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

/** Ввод-вывод для локального источника (инжектируется; реальный — поверх node:fs). */
export interface LocalIo {
  /** Все файлы под корнем (рекурсивно; node_modules/.git/бинарь — пропускаются на этом уровне). */
  listFiles(root: string): string[];
  /** Прочитать файл как текст. */
  readText(path: string): string;
}

/**
 * Загружает текстовые документы из локальной папки: фильтрует по расширению и размеру, строит
 * метаданные (file — путь относительно корня, title — имя файла). Пустые/огромные — пропускает.
 */
export function loadLocalDocuments(root: string, io: LocalIo, maxBytes = 1_000_000): Document[] {
  const documents: Document[] = [];
  for (const path of io.listFiles(root)) {
    if (!isTextFile(path)) {
      continue;
    }
    const text = io.readText(path);
    if (text.trim() === '' || text.length > maxBytes) {
      continue;
    }
    documents.push({
      source: root,
      file: relative(root, path) || basename(path),
      title: basename(path),
      text,
    });
  }
  return documents;
}
