import type { Chunk, ChunkStrategy, Document, FixedOptions } from './types.ts';

/** Строка-заголовок markdown: 1–6 решёток, пробел, текст. */
const HEADING = /^(#{1,6})\s+(.+)$/;

/** Markdown ли файл (по расширению). */
function isMarkdown(file: string): boolean {
  return /\.(md|markdown)$/i.test(file);
}

/** Собирает чанк с метаданными; текст хранится обрезанным по краям. */
function makeChunk(doc: Document, ordinal: number, section: string, text: string): Chunk {
  return {
    chunk_id: `${doc.file}#${ordinal}`,
    source: doc.source,
    file: doc.file,
    title: doc.title,
    section,
    text: text.trim(),
  };
}

/** Режет текст на непересекающиеся куски не длиннее max (для до-резки огромных разделов). */
function splitByLength(text: string, max: number): string[] {
  const pieces: string[] = [];
  for (let start = 0; start < text.length; start += max) {
    pieces.push(text.slice(start, start + max));
  }
  return pieces;
}

/**
 * Стратегия «fixed»: режет текст на куски заданного размера (символы) с перекрытием overlap.
 * Section — порядковый номер фрагмента (структуры нет). Пустые/пробельные куски пропускаются.
 */
export function chunkFixed(doc: Document, options: FixedOptions): Chunk[] {
  if (doc.text.trim() === '') {
    return [];
  }
  const step = Math.max(1, options.size - options.overlap);
  const chunks: Chunk[] = [];
  let ordinal = 0;
  for (let start = 0; start < doc.text.length; start += step) {
    const slice = doc.text.slice(start, start + options.size);
    if (slice.trim() !== '') {
      chunks.push(makeChunk(doc, ordinal, `фрагмент ${ordinal + 1}`, slice));
      ordinal++;
    }
    if (start + options.size >= doc.text.length) {
      break;
    }
  }
  return chunks;
}

/** Разбивает markdown на разделы по заголовкам; преамбула до первого — раздел с именем title. */
function splitMarkdownSections(doc: Document): { section: string; text: string }[] {
  const sections: { section: string; text: string }[] = [];
  let section = doc.title;
  let lines: string[] = [];
  const flush = () => {
    if (lines.length > 0) {
      sections.push({ section, text: lines.join('\n') });
    }
  };
  for (const line of doc.text.split('\n')) {
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      section = heading[2].trim();
      lines = [line];
    } else {
      lines.push(line);
    }
  }
  flush();
  return sections;
}

/**
 * Стратегия «structural»: режет по структуре. Markdown — по заголовкам (раздел = чанк), прочее
 * (код/текст) — файл целиком. Огромный раздел до-резается по длине, сохраняя имя раздела.
 */
export function chunkStructural(doc: Document, maxSize: number): Chunk[] {
  const sections = isMarkdown(doc.file)
    ? splitMarkdownSections(doc)
    : [{ section: doc.title, text: doc.text }];
  const chunks: Chunk[] = [];
  let ordinal = 0;
  for (const part of sections) {
    if (part.text.trim() === '') {
      continue;
    }
    if (part.text.length <= maxSize) {
      chunks.push(makeChunk(doc, ordinal++, part.section, part.text));
    } else {
      for (const piece of splitByLength(part.text, maxSize)) {
        chunks.push(makeChunk(doc, ordinal++, part.section, piece));
      }
    }
  }
  return chunks;
}

/** Параметры чанкинга для диспетчера. */
export interface ChunkOptions {
  fixed: FixedOptions;
  structuralMaxSize: number;
}

/** Разбивает документ выбранной стратегией. */
export function chunkDocument(
  doc: Document,
  strategy: ChunkStrategy,
  options: ChunkOptions,
): Chunk[] {
  return strategy === 'fixed'
    ? chunkFixed(doc, options.fixed)
    : chunkStructural(doc, options.structuralMaxSize);
}
