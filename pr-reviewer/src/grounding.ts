import { buildIndex, topK } from '../../rag/src/index.ts';
import type { Document, EmbedFn } from '../../rag/src/index.ts';
import type { DiffFile } from './diff.ts';

/** Зависимости обоснования ревью (инъекция — для тестов без сети/ФС). */
export interface GroundingDeps {
  /** Эмбеддинги (обычно `EmbeddingsClient.embed`). */
  embed: EmbedFn;
  /** Документы проекта (обычно `loadLocalDocuments` по `docSources`). */
  loadDocs: () => Document[];
  /** Момент сборки индекса (ISO) — время инжектируется, в логике его нет. */
  now: string;
  /** Сколько фрагментов вернуть. */
  topKCount: number;
}

/** Параметры чанкинга доков — structural (markdown по заголовкам). */
const CHUNK_OPTIONS = { fixed: { size: 2000, overlap: 200 }, structuralMaxSize: 2000 };

/** Рендер фрагмента документации: путь › раздел + тело. */
function renderFragment(file: string, section: string, text: string): string {
  return `${file}${section ? ` › ${section}` : ''}\n${text}`;
}

/**
 * Фрагменты документации по запросу через RAG: индексирует доки, эмбеддит запрос, берёт top-k. Если
 * эмбеддинги недоступны (нет эндпоинта/сеть) — МЯГКАЯ ДЕГРАДАЦИЯ: возвращает сырые доки как есть
 * (обрезку по бюджету делает сборка промпта ревью). Нет доков → пустой список.
 */
export async function groundDocs(deps: GroundingDeps, query: string): Promise<string[]> {
  const docs = deps.loadDocs();
  if (docs.length === 0) {
    return [];
  }
  try {
    const index = await buildIndex(docs, {
      strategy: 'structural',
      chunk: CHUNK_OPTIONS,
      embed: deps.embed,
      model: 'pr-reviewer-docs',
      createdAt: deps.now,
    });
    const [queryVector] = await deps.embed([query]);
    if (queryVector === undefined) {
      throw new Error('пустой вектор запроса');
    }
    return topK(queryVector, index.chunks, deps.topKCount).map(scored =>
      renderFragment(scored.chunk.file, scored.chunk.section, scored.chunk.text),
    );
  } catch {
    // эмбеддинги недоступны — отдаём доки напрямую (бюджет режет сборка промпта)
    return docs.map(doc => renderFragment(doc.file, '', doc.text));
  }
}

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
