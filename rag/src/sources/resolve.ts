import type { Document } from '../types.ts';
import { isGithubUrl } from './github.ts';

/** Тип источника документов. */
export type SourceKind = 'github' | 'web' | 'local';

/** Определяет тип источника по входной строке: github.com → github; http(s) → web; иначе путь. */
export function detectSource(input: string): SourceKind {
  if (isGithubUrl(input)) {
    return 'github';
  }
  if (/^https?:\/\//i.test(input)) {
    return 'web';
  }
  return 'local';
}

/** Загрузчики по типам источника (реальные — поверх node:fs/fetch; инжектируются). */
export interface SourceLoaders {
  local(input: string): Promise<Document[]>;
  github(input: string): Promise<Document[]>;
  web(input: string): Promise<Document[]>;
}

/** Загружает документы из источника, выбрав загрузчик по автоопределённому типу. */
export function loadDocuments(input: string, loaders: SourceLoaders): Promise<Document[]> {
  const kind = detectSource(input);
  if (kind === 'github') {
    return loaders.github(input);
  }
  if (kind === 'web') {
    return loaders.web(input);
  }
  return loaders.local(input);
}
