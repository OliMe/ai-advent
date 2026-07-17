import { relative, join } from 'node:path';
import type { SearchChunk } from '../../grounding/src/index.ts';
import { normalizeForMatch } from '../../grounding/src/index.ts';

/**
 * Превращает строки секции «Источники» в кликабельные ссылки на файл FAQ в репозитории и КОНКРЕТНЫЙ
 * раздел (по якорю заголовка GitHub). Файл и раздел берутся из реальных чанков (не из текста модели),
 * поэтому ссылка ведёт туда, откуда взят ответ. Чисто и детерминированно — без обращений к сети.
 */

/** Контекст ссылок: база blob-URL репозитория + корень для относительного пути файла. */
export interface SourceLinkContext {
  /** `https://<host>/<owner>/<repo>/blob/<ref>` (ref — SHA или ветка). */
  blobBaseUrl: string;
  /** Абсолютный корень репозитория — путь файла считается относительно него. */
  repoRoot: string;
}

/** Веб-база репозитория из `html_url` тикета (часть до `/issues/`); null — не распознан. */
export function repoWebBaseFromTicketUrl(ticketUrl: string): string | null {
  const marker = '/issues/';
  const index = ticketUrl.indexOf(marker);
  return index === -1 ? null : ticketUrl.slice(0, index);
}

/**
 * Собирает контекст ссылок из url тикета + git-ref + корня репозитория. null (ссылки не строятся),
 * если url тикета не распознан или ref/корень пусты — тогда «Источники» остаются простым текстом.
 */
export function buildSourceLinkContext(
  ticketUrl: string,
  ref: string,
  repoRoot: string,
): SourceLinkContext | null {
  const webBase = repoWebBaseFromTicketUrl(ticketUrl);
  if (webBase === null || ref === '' || repoRoot === '') {
    return null;
  }
  return { blobBaseUrl: `${webBase}/blob/${ref}`, repoRoot };
}

/**
 * Якорь заголовка по правилам GitHub: нижний регистр, убрать всё кроме букв/цифр/пробела/дефиса/
 * подчёркивания, пробелы → дефисы. Кириллица сохраняется (GitHub оставляет её в якоре как есть).
 */
export function githubHeadingAnchor(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} \-_]/gu, '')
    .replace(/\s+/g, '-');
}

/** Путь файла чанка относительно корня репозитория, POSIX-разделители (для URL). */
function repoRelativePath(chunk: SearchChunk, repoRoot: string): string {
  return relative(repoRoot, join(chunk.source, chunk.file))
    .split(/[\\/]/)
    .map(encodeURIComponent)
    .join('/');
}

/** Ссылка на файл (+ якорь раздела, если он надёжно сопоставлен). */
function chunkLink(chunk: SearchChunk, context: SourceLinkContext, useAnchor: boolean): string {
  const path = repoRelativePath(chunk, context.repoRoot);
  const anchor = useAnchor ? githubHeadingAnchor(chunk.section) : '';
  return `${context.blobBaseUrl}/${path}${anchor === '' ? '' : `#${anchor}`}`;
}

/** Разбивает метку «файл › раздел [· chunk_id]» на часть-файл и часть-раздел; null — нет разделителя. */
function splitSourceLabel(label: string): { filePart: string; sectionPart: string } | null {
  const index = label.indexOf('›');
  if (index === -1) {
    return null;
  }
  const filePart = label.slice(0, index).trim();
  const rest = label.slice(index + 1).trim();
  const chunkIdMark = rest.indexOf('·');
  const sectionPart = (chunkIdMark === -1 ? rest : rest.slice(0, chunkIdMark)).trim();
  return filePart === '' || sectionPart === '' ? null : { filePart, sectionPart };
}

/**
 * Строка-пункт «Источников» → ссылки: часть-ФАЙЛ ведёт на файл (без якоря), часть-РАЗДЕЛ — на
 * конкретную секцию (якорь). Нет надёжного якоря → раздел остаётся текстом. Нет разделителя `›` в
 * метке → вся метка одной ссылкой (на секцию, если якорь надёжен, иначе на файл).
 */
function renderSourceLink(
  prefix: string,
  label: string,
  match: { chunk: SearchChunk; useAnchor: boolean },
  context: SourceLinkContext,
): string {
  const fileUrl = chunkLink(match.chunk, context, false);
  const split = splitSourceLabel(label);
  if (split === null) {
    return `${prefix}[${label}](${chunkLink(match.chunk, context, match.useAnchor)})`;
  }
  const sectionRendered = match.useAnchor
    ? `[${split.sectionPart}](${chunkLink(match.chunk, context, true)})`
    : split.sectionPart;
  return `${prefix}[${split.filePart}](${fileUrl}) › ${sectionRendered}`;
}

/**
 * Подбирает чанк под строку «Источника»: сначала совпадение по ФАЙЛУ и РАЗДЕЛУ (тогда якорь надёжен),
 * иначе только по файлу (ссылка на файл без якоря — лучше, чем неверный якорь). Нет файла — null.
 */
function matchSource(
  label: string,
  chunks: SearchChunk[],
): { chunk: SearchChunk; useAnchor: boolean } | null {
  const haystack = normalizeForMatch(label);
  let fileOnly: SearchChunk | null = null;
  for (const chunk of chunks) {
    const file = normalizeForMatch(chunk.file);
    if (file.length >= 3 && haystack.includes(file)) {
      const section = normalizeForMatch(chunk.section);
      if (section.length > 0 && haystack.includes(section)) {
        return { chunk, useAnchor: true };
      }
      fileOnly ??= chunk;
    }
  }
  return fileOnly === null ? null : { chunk: fileOnly, useAnchor: false };
}

/** Тип секции по строке-заголовку ответа (после снятия markdown-маркеров). */
function sectionOf(line: string): 'sources' | 'citations' | 'answer' | null {
  const cleaned = line
    .trim()
    .replace(/^[#>*\-\s]+/, '')
    .toLowerCase();
  if (cleaned.startsWith('источник')) {
    return 'sources';
  }
  if (cleaned.startsWith('цитат')) {
    return 'citations';
  }
  if (cleaned.startsWith('ответ')) {
    return 'answer';
  }
  return null;
}

/**
 * Заменяет строки-пункты секции «Источники» кликабельными ссылками на файл+раздел в репозитории.
 * Текст пункта остаётся видимой подписью ссылки. Пункт, который не удалось сопоставить с чанком, и
 * любые строки вне «Источников» (в т.ч. «Цитаты») не трогаются. Нет контекста/чанков → ответ как есть.
 */
export function linkifySources(
  answer: string,
  chunks: SearchChunk[],
  context: SourceLinkContext | null,
): string {
  if (context === null || chunks.length === 0) {
    return answer;
  }
  let inSources = false;
  const lines = answer.split('\n').map(line => {
    const section = sectionOf(line);
    if (section !== null) {
      inSources = section === 'sources';
      return line;
    }
    if (!inSources) {
      return line;
    }
    const bullet = line.match(/^(\s*[-*•]\s+)(.*)$/);
    if (bullet === null || bullet[2].trim() === '') {
      return line;
    }
    const label = bullet[2].trim();
    const match = matchSource(label, chunks);
    if (match === null) {
      return line;
    }
    return renderSourceLink(bullet[1], label, match, context);
  });
  return lines.join('\n');
}
