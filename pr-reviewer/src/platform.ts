import type { DiffFile } from './diff.ts';

// HTTP-клиент с ретраями вынесен в `core` (провайдеро-независим, нужен и MCP-серверам/ботам).
// Реэкспорт — чтобы `github.ts` и баррель пакета не меняли пути импорта.
export { requestJson } from '../../core/src/index.ts';
export type { HttpResponse, FetchLike, RequestOptions } from '../../core/src/index.ts';

/** Изменения PR/MR: метаданные + изменённые файлы (уже разобранные в DiffFile). */
export interface PullChanges {
  title: string;
  description: string;
  files: DiffFile[];
  /** Признак, что список файлов усечён (достигнут потолок страниц) — честно сообщаем. */
  truncated: boolean;
}

/** Одна инлайн-заметка: файл, строка новой версии и текст. */
export interface InlineComment {
  file: string;
  line: number;
  body: string;
}

/** Публикуемое ревью: сводный текст + инлайн-заметки. */
export interface ReviewPublication {
  summary: string;
  comments: InlineComment[];
}

/** Платформа хостинга: получить изменения PR и идемпотентно опубликовать ревью. */
export interface ReviewPlatform {
  fetchChanges(): Promise<PullChanges>;
  /** Идемпотентная публикация: снять свои прежние инлайн-комментарии, обновить сводку, поставить свежие. */
  publish(review: ReviewPublication): Promise<void>;
}
