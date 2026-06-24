import { homedir } from 'node:os';
import { join, extname } from 'node:path';
import { statSync, readFileSync } from 'node:fs';

/** MIME-тип изображения по расширению файла (для поля mimeType инструмента распознавания). */
const MIME_TYPE_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.pdf': 'application/pdf',
};

/** Возвращает MIME-тип изображения по расширению пути или undefined для незнакомых. */
export function inferImageMimeType(path: string): string | undefined {
  return MIME_TYPE_BY_EXTENSION[extname(path).toLowerCase()];
}

/** Разворачивает ведущую тильду пути в домашний каталог пользователя. */
export function expandHomeDirectory(path: string): string {
  if (path === '~') {
    return homedir();
  }
  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

/** Низкоуровневые файловые операции — шов для тестов (реальный — поверх node:fs). */
export interface LocalFileReader {
  /** Существует ли путь и является ли он обычным файлом. */
  isFile(path: string): boolean;
  /** Читает содержимое файла. */
  read(path: string): Buffer;
}

/** Реальный читатель локальных файлов поверх node:fs. */
export const nodeFileReader: LocalFileReader = {
  isFile: path => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
  read: path => readFileSync(path),
};

/**
 * Читает локальный файл изображения и возвращает его содержимое в base64 вместе с
 * предполагаемым MIME-типом. Бросает понятную ошибку, если файла нет (тильда разворачивается).
 */
export function readLocalImageAsBase64(
  rawPath: string,
  reader: LocalFileReader = nodeFileReader,
): { base64: string; mimeType: string | undefined } {
  const path = expandHomeDirectory(rawPath);
  if (!reader.isFile(path)) {
    throw new Error(`файл не найден: ${rawPath}`);
  }
  return { base64: reader.read(path).toString('base64'), mimeType: inferImageMimeType(path) };
}
