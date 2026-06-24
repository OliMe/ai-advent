import type { ToolSet, ToolSpec } from '../../core/src/index.ts';
import { readLocalImageAsBase64, nodeFileReader, type LocalFileReader } from './local-image.ts';

/** Суффикс имени инструмента распознавания (с учётом неймспейса «сервер__recognize-text»). */
const RECOGNIZE_TOOL_SUFFIX = 'recognize-text';

/** Подходит ли инструмент под распознавание текста (по суффиксу имени). */
export function isRecognizeTool(name: string): boolean {
  return name.endsWith(RECOGNIZE_TOOL_SUFFIX);
}

/**
 * Директива агенту, когда доступен инструмент распознавания: как обращаться с локальными
 * путями и что отвечать при неудаче. Возвращает null, если такого инструмента нет.
 */
export function recognizeTextDirective(specs: ToolSpec[]): string | null {
  if (!specs.some(spec => isRecognizeTool(spec.name))) {
    return null;
  }
  return (
    'Тебе доступен инструмент распознавания текста на изображении (recognize-text). ' +
    'Если в сообщении пользователя есть путь к локальному файлу изображения, вызови этот ' +
    'инструмент, передав путь в поле path. Приведи распознанный текст в ответе, чтобы он ' +
    'остался в контексте диалога. Если распознать не удалось (ошибка инструмента или пустой ' +
    'результат), ответь ровно: «Текст не удалось распознать.»'
  );
}

/**
 * Обёртка над набором инструментов: вызовы recognize-text с ЛОКАЛЬНЫМ путём (path)
 * перехватываются — файл читается на стороне CLI и уходит на сервер как base64 (серверный
 * path резолвится в файловой системе сервера, недоступной отсюда). Остальные вызовы и
 * источники (url/base64) проходят насквозь. Так путь к локальному файлу «просто из текста»
 * становится распознаваемым удалённым сервером.
 */
export class LocalImageRecognizingToolSet implements ToolSet {
  private readonly inner: ToolSet;
  private readonly reader: LocalFileReader;

  constructor(inner: ToolSet, reader: LocalFileReader = nodeFileReader) {
    this.inner = inner;
    this.reader = reader;
  }

  specs(): ToolSpec[] {
    return this.inner.specs();
  }

  async call(name: string, args: Record<string, unknown>): Promise<string> {
    const path = args.path;
    if (isRecognizeTool(name) && typeof path === 'string' && path.trim() !== '') {
      const { base64, mimeType } = readLocalImageAsBase64(path, this.reader);
      const { path: _localPath, ...rest } = args;
      const next: Record<string, unknown> = { ...rest, base64 };
      if (mimeType !== undefined && rest.mimeType === undefined) {
        next.mimeType = mimeType;
      }
      return this.inner.call(name, next);
    }
    return this.inner.call(name, args);
  }
}
