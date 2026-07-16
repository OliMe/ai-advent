import type { DiffFile } from './diff.ts';

/**
 * Читает полное содержимое изменённых файлов (для понимания кода вокруг ханков). Удалённые и
 * бинарные файлы пропускает (читать нечего); нечитаемый файл — тоже (`readFile` вернул null).
 */
export function readChangedFiles(
  files: DiffFile[],
  readFile: (path: string) => string | null,
): { path: string; content: string }[] {
  const contents: { path: string; content: string }[] = [];
  for (const file of files) {
    if (file.status === 'removed' || file.status === 'binary') {
      continue;
    }
    const content = readFile(file.path);
    if (content !== null) {
      contents.push({ path: file.path, content });
    }
  }
  return contents;
}
