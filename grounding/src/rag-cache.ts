import { buildIndex, topK } from '../../rag/src/index.ts';
import type { Document, EmbedFn, Index } from '../../rag/src/index.ts';
import type { IndexCache } from './index-cache.ts';
import { computeIndexCacheKey } from './index-cache.ts';
import type { SearchChunk } from './rag-answer.ts';

/** Зависимости обоснования по докам через RAG (инъекция — для тестов без сети/ФС). */
export interface GroundingDeps {
  /** Эмбеддинги (обычно `EmbeddingsClient.embed`). */
  embed: EmbedFn;
  /** Документы (обычно `loadLocalDocuments` по источникам). */
  loadDocs: () => Document[];
  /** Момент сборки индекса (ISO) — время инжектируется, в логике его нет. */
  now: string;
  /** Сколько фрагментов вернуть. */
  topKCount: number;
  /**
   * Кэш индекса доков (опц.). Есть → корпус эмбеддится ОДИН раз (по неизменным докам — из кэша), нет →
   * индекс собирается на каждый прогон. Эмбеддинг запроса делается всегда (один вектор — дёшево).
   */
  cache?: IndexCache;
  /**
   * Идентификатор схемы эмбеддинга (обычно имя модели) — часть ключа кэша: смена модели даёт другие
   * вектора, старый индекс несовместим и должен пересобраться.
   */
  embeddingId?: string;
}

/** Параметры чанкинга доков — structural (markdown по заголовкам). */
const CHUNK_OPTIONS = { fixed: { size: 2000, overlap: 200 }, structuralMaxSize: 2000 };

/** Стратегия чанкинга доков (часть ключа кэша). */
const DOCS_STRATEGY = 'structural' as const;

/** Имя модели в метаданных индекса (косметика; на ключ кэша не влияет — там своя схема эмбеддинга). */
const DOCS_INDEX_MODEL = 'grounding-docs';

/** Рендер фрагмента документации: путь › раздел + тело. */
function renderFragment(file: string, section: string, text: string): string {
  return `${file}${section ? ` › ${section}` : ''}\n${text}`;
}

/**
 * Индекс доков: из кэша (если задан и есть валидный по ключу-содержимому) либо сборка «с нуля» с
 * последующим сохранением в кэш. Без кэша — просто сборка (прежнее поведение).
 */
async function loadOrBuildIndex(deps: GroundingDeps, docs: Document[]): Promise<Index> {
  const build = () =>
    buildIndex(docs, {
      strategy: DOCS_STRATEGY,
      chunk: CHUNK_OPTIONS,
      embed: deps.embed,
      model: DOCS_INDEX_MODEL,
      createdAt: deps.now,
    });
  if (deps.cache === undefined) {
    return build();
  }
  const key = computeIndexCacheKey(docs, DOCS_STRATEGY, deps.embeddingId ?? '');
  const cached = deps.cache.load(key);
  if (cached !== null) {
    return cached;
  }
  const built = await build();
  deps.cache.save(key, built);
  return built;
}

/**
 * Прогрев кэша: собрать индекс доков (и сохранить в кэш) — БЕЗ мягкой деградации. В отличие от
 * `groundDocs`, ошибка эмбеддера здесь ПРОБРАСЫВАЕТСЯ: фоновый пре-варм должен ВИДИМО падать (job в CI
 * покраснеет), а не молча остаться «зелёным, но с пустым кэшем». Возвращает число чанков в индексе.
 * Нет доков → 0 (кэшировать нечего). Ревью-путь (`groundDocs`) деградацию сохраняет — он не должен
 * падать из-за недоступного эмбеддера.
 */
export async function warmDocsIndex(deps: GroundingDeps): Promise<number> {
  const docs = deps.loadDocs();
  if (docs.length === 0) {
    return 0;
  }
  const index = await loadOrBuildIndex(deps, docs);
  return index.chunks.length;
}

/**
 * Фрагменты документации по запросу как СТРУКТУРНЫЕ чанки (для цитатного гейта: источник — по
 * file/source/chunk_id, дословная цитата — подстрока text). В отличие от `groundDocs` (строки для
 * промпта), возвращает `SearchChunk[]`. Эмбеддинги недоступны — деградация: весь документ одним чанком.
 * Нет доков → пустой список (тогда гейт отвечает «не знаю»).
 */
export async function retrieveDocChunks(
  deps: GroundingDeps,
  query: string,
): Promise<SearchChunk[]> {
  const docs = deps.loadDocs();
  if (docs.length === 0) {
    return [];
  }
  try {
    const index = await loadOrBuildIndex(deps, docs);
    const [queryVector] = await deps.embed([query]);
    if (queryVector === undefined) {
      throw new Error('пустой вектор запроса');
    }
    return topK(queryVector, index.chunks, deps.topKCount).map(scored => ({
      chunk_id: scored.chunk.chunk_id,
      source: scored.chunk.source,
      file: scored.chunk.file,
      section: scored.chunk.section,
      score: scored.score,
      text: scored.chunk.text,
    }));
  } catch {
    // эмбеддинги недоступны — весь документ одним чанком (гейт всё равно сможет сослаться на файл)
    return docs.map(doc => ({
      chunk_id: doc.file,
      source: doc.source,
      file: doc.file,
      section: '',
      score: 0,
      text: doc.text,
    }));
  }
}

/**
 * Фрагменты документации по запросу через RAG: берёт индекс (из кэша или сборкой), эмбеддит запрос,
 * возвращает top-k. Если эмбеддинги недоступны (нет эндпоинта/сеть) — МЯГКАЯ ДЕГРАДАЦИЯ: возвращает
 * сырые доки как есть (обрезку по бюджету делает вызывающий). Нет доков → пустой список.
 */
export async function groundDocs(deps: GroundingDeps, query: string): Promise<string[]> {
  const docs = deps.loadDocs();
  if (docs.length === 0) {
    return [];
  }
  try {
    const index = await loadOrBuildIndex(deps, docs);
    const [queryVector] = await deps.embed([query]);
    if (queryVector === undefined) {
      throw new Error('пустой вектор запроса');
    }
    return topK(queryVector, index.chunks, deps.topKCount).map(scored =>
      renderFragment(scored.chunk.file, scored.chunk.section, scored.chunk.text),
    );
  } catch {
    // эмбеддинги недоступны — отдаём доки напрямую (бюджет режет вызывающий)
    return docs.map(doc => renderFragment(doc.file, '', doc.text));
  }
}
