import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

/** Источник изображения из буфера обмена: путь к сохранённому файлу или null, если картинки нет. */
export interface ClipboardImageReader {
  /** Сохраняет изображение из буфера во временный файл и возвращает путь; null — картинки нет. */
  read(): string | null;
}

/** Запуск внешней команды с возвратом stdout — шов для тестов. */
export type CommandRunner = (command: string, args: string[]) => string;

/** AppleScript (macOS): сохраняет PNG из буфера обмена в файл; печатает ok либо none. */
function clipboardScriptArguments(path: string): string[] {
  return [
    '-e',
    `set outputFile to POSIX file ${JSON.stringify(path)}`,
    '-e',
    'try',
    '-e',
    'set pngData to the clipboard as «class PNGf»',
    '-e',
    'on error',
    '-e',
    'return "none"',
    '-e',
    'end try',
    '-e',
    'set fileHandle to open for access outputFile with write permission',
    '-e',
    'set eof fileHandle to 0',
    '-e',
    'write pngData to fileHandle',
    '-e',
    'close access fileHandle',
    '-e',
    'return "ok"',
  ];
}

let temporaryFileCounter = 0;

/** Путь к новому временному файлу для картинки из буфера (уникальный в пределах процесса). */
export function defaultClipboardTempPath(): string {
  temporaryFileCounter += 1;
  return join(tmpdir(), `llm-cli-clipboard-${process.pid}-${temporaryFileCounter}.png`);
}

/** Реальный запуск команды через child_process (utf8 stdout). */
export const realCommandRunner: CommandRunner = (command, args) =>
  execFileSync(command, args, { encoding: 'utf8' });

/**
 * Читает изображение из буфера обмена в временный файл и возвращает его путь. Возвращает null,
 * если в буфере нет картинки или команда недоступна (на не-macOS — тоже null). Реализовано
 * через системный osascript, поэтому ничего ставить не нужно.
 */
export function readClipboardImage(
  runner: CommandRunner = realCommandRunner,
  makePath: () => string = defaultClipboardTempPath,
): string | null {
  const path = makePath();
  try {
    return runner('osascript', clipboardScriptArguments(path)).trim() === 'ok' ? path : null;
  } catch {
    return null;
  }
}

/** Реальный читатель буфера обмена для macOS. */
export const macClipboardImageReader: ClipboardImageReader = {
  read: () => readClipboardImage(),
};

/** Контроллер вставок из буфера: разрешает плейсхолдеры [Image #N] в текст текущего промпта. */
export interface ClipboardPasteController {
  /**
   * Заменяет плейсхолдеры [Image #N] на пути к их временным файлам и сбрасывает счётчик
   * (начало нового промпта). Текст без плейсхолдеров возвращается как есть.
   */
  consume(text: string): string;
}

/**
 * Вешает на ввод перехват Ctrl+V: читает картинку из буфера во временный файл и вставляет в
 * строку ввода плейсхолдер [Image #N] (N — номер картинки в текущем промпте), без пометок ниже.
 * В одном промпте можно вставить несколько изображений (N растёт). Нет картинки — ничего не
 * вставляется. Возвращает контроллер, который на отправке меняет плейсхолдеры на пути к файлам.
 * В терминале readline эмитит события «keypress»; в тестах их можно подать вручную.
 */
export function installClipboardPaste(
  input: { on(event: 'keypress', listener: (sequence: string, key: KeyEvent) => void): unknown },
  lineWriter: { write(data: string): unknown },
  clipboard: ClipboardImageReader,
): ClipboardPasteController {
  let imageCount = 0;
  let pathByPlaceholder = new Map<string, string>();
  input.on('keypress', (_sequence, key) => {
    if (key?.ctrl && key.name === 'v') {
      const path = clipboard.read();
      if (path === null) {
        return;
      }
      imageCount += 1;
      const placeholder = `[Image #${imageCount}]`;
      pathByPlaceholder.set(placeholder, path);
      lineWriter.write(`${placeholder} `);
    }
  });
  return {
    consume(text) {
      let resolved = text;
      for (const [placeholder, path] of pathByPlaceholder) {
        resolved = resolved.replaceAll(placeholder, path);
      }
      imageCount = 0;
      pathByPlaceholder = new Map();
      return resolved;
    },
  };
}

/** Сведения о клавише из событий readline «keypress» (минимум, что нам нужен). */
interface KeyEvent {
  ctrl?: boolean;
  name?: string;
}
