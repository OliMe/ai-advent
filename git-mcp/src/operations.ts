import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';

/** Результат git-команды: вывод (stdout, при неудаче — stderr) и признак успеха (код возврата 0). */
export interface GitResult {
  output: string;
  ok: boolean;
}

/**
 * Низкоуровневые операции над репозиторием (шов для тестов; реальные — поверх `git` и `node:fs`).
 * `run` запускает git с ГОТОВЫМ массивом аргументов (без шелла) — строку от модели в argv не
 * пускаем никогда, поэтому подставить свои флаги или подкоманду невозможно. Ненулевой код возврата
 * не бросает исключение, а возвращается как `ok: false`: для git это штатный ответ (например
 * `git grep` без совпадений), и обработчик решает, ошибка это или пустой результат.
 */
export interface GitIo {
  run(args: string[], cwd: string): GitResult;
  readText(path: string): string;
  stat(path: string): 'file' | 'dir' | null;
}

/** Потолок вывода одной git-команды (защита от гигантского diff в буфере процесса). */
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/** Текст неудачной команды: сначала stderr git, иначе сообщение об ошибке запуска. */
export function commandErrorOutput(error: unknown): string {
  const failure = error as { stderr?: unknown; message?: unknown };
  if (typeof failure.stderr === 'string' && failure.stderr.trim() !== '') {
    return failure.stderr;
  }
  return typeof failure.message === 'string' ? failure.message : String(error);
}

/** Реальная реализация: git через `execFileSync` (без шелла) + чтение рабочего дерева. */
export const nodeGitIo: GitIo = {
  run: (args, cwd) => {
    try {
      const output = execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        maxBuffer: MAX_BUFFER_BYTES,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { output, ok: true };
    } catch (error) {
      return { output: commandErrorOutput(error), ok: false };
    }
  },
  readText: path => readFileSync(path, 'utf8'),
  stat: path => (existsSync(path) ? (statSync(path).isDirectory() ? 'dir' : 'file') : null),
};
