import type { ChunkStrategy, EmbedFn, Index } from '../../rag/src/index.ts';
import type { RagConfig } from './config.ts';
import { retrieve } from './retrieval.ts';
import { formatResults, formatIndexes } from './format.ts';

/** Зависимости обработчиков (инжектируются; реальные — в runtime поверх fs/эмбеддингов/rag). */
export interface ToolDeps {
  config: RagConfig;
  /** Эмбеддер запроса. */
  embed: EmbedFn;
  /** Гарантирует индекс источника (из кэша или строит на лету). */
  ensure(source: string, strategy: ChunkStrategy): Promise<Index>;
  /** Все кэшированные индексы (для поиска без source и для list_indexes). */
  loadAllCached(): Index[];
}

/** Текст ошибки из неизвестного значения. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Непустая строка из аргумента или null. */
function stringArg(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** Конечное число из аргумента или null. */
function numberArg(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Стратегия из аргумента (fixed/structural) или дефолт конфига. */
function resolveStrategy(value: unknown, fallback: ChunkStrategy): ChunkStrategy {
  if (value === 'fixed') {
    return 'fixed';
  }
  if (value === 'structural') {
    return 'structural';
  }
  return fallback;
}

/**
 * search_docs: ищет релевантные фрагменты по запросу. С source — индексирует его на лету (или
 * берёт из кэша) и ищет в нём; без source — по всем кэшированным индексам. Возвращает текст с
 * пронумерованными фрагментами и метками источников.
 */
export async function handleSearchDocs(
  deps: ToolDeps,
  args: Record<string, unknown>,
): Promise<string> {
  const query = stringArg(args.query);
  if (query === null) {
    return 'Нужен непустой query (что искать в документах).';
  }
  const strategy = resolveStrategy(args.strategy, deps.config.strategy);
  const k = numberArg(args.k) ?? deps.config.k;
  const source = stringArg(args.source);
  try {
    const indexes = source === null ? deps.loadAllCached() : [await deps.ensure(source, strategy)];
    if (indexes.length === 0) {
      return 'Нет source и пустой кэш. Укажите source (github-url / путь / url документации).';
    }
    const scored = await retrieve(
      query,
      indexes,
      { k, kPre: Math.max(k, deps.config.kPre), queryPrefix: deps.config.queryPrefix },
      deps.embed,
    );
    return formatResults(query, scored);
  } catch (error) {
    return errorText(error);
  }
}

/** list_indexes: перечисляет кэшированные индексы. */
export function handleListIndexes(deps: ToolDeps): string {
  return formatIndexes(deps.loadAllCached());
}

/** build_index: заранее индексирует источник (или переиндексирует), возвращает сводку. */
export async function handleBuildIndex(
  deps: ToolDeps,
  args: Record<string, unknown>,
): Promise<string> {
  const source = stringArg(args.source);
  if (source === null) {
    return 'Нужен непустой source (github-url / путь / url документации).';
  }
  const strategy = resolveStrategy(args.strategy, deps.config.strategy);
  try {
    const index = await deps.ensure(source, strategy);
    return `Индекс готов: ${source} [${strategy}] — чанков ${index.chunks.length} (${index.dimensions}d).`;
  } catch (error) {
    return errorText(error);
  }
}
