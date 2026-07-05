import type { ChunkStrategy, EmbedFn, Index } from '../../rag/src/index.ts';
import type { RagConfig } from './config.ts';
import { retrieve } from './retrieval.ts';
import type { RerankMode, RetrieveHooks } from './retrieval.ts';
import { makeRewriter } from './rewrite.ts';
import type { ChatComplete, RewriteMode } from './rewrite.ts';
import { resolveDocLanguage } from './language.ts';
import { makeChatRerankProvider, makeLlmReranker } from './rerank-llm.ts';
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
  /** Chat-обращение для rewrite/LLM-реранка (если задана chat-модель); иначе не задан. */
  chatComplete?: ChatComplete;
  /** Дозаписать определённый язык в кэш индекса источника (после дорогого LLM-детекта). Опц. */
  persistLanguage?(source: string, strategy: ChunkStrategy, index: Index): void;
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

/** Порог косинуса из аргумента (в [0,1]) или null. */
function minScoreArg(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : null;
}

/** Режим rerank из аргумента (none/mmr/llm) или null. */
function rerankArg(value: unknown): RerankMode | null {
  return value === 'none' || value === 'mmr' || value === 'llm' ? value : null;
}

/** Режим rewrite из аргумента (none/expand/hyde) или null. */
function rewriteArg(value: unknown): RewriteMode | null {
  return value === 'none' || value === 'expand' || value === 'hyde' ? value : null;
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
 * Собирает хуки конвейера под эффективные режимы: rewrite (expand/hyde) и LLM-реранк подключаются
 * только при наличии chat-модели. Без неё — пустые хуки (конвейер идёт как есть).
 */
function buildHooks(
  chatComplete: ChatComplete | undefined,
  rewriteMode: RewriteMode,
  rerankMode: RerankMode,
  targetLanguage?: string,
): RetrieveHooks {
  const hooks: RetrieveHooks = {};
  if (chatComplete === undefined) {
    return hooks;
  }
  if (rewriteMode !== 'none') {
    hooks.rewrite = makeRewriter(rewriteMode, chatComplete, targetLanguage);
  }
  if (rerankMode === 'llm') {
    hooks.rerankLlm = makeLlmReranker(makeChatRerankProvider(chatComplete));
  }
  return hooks;
}

/**
 * Язык корпуса для кросс-язычного rewrite: считаем только когда rewrite активен и есть chat-модель
 * (иначе rewrite всё равно не строится). Приоритет override → кэш индекса → LLM-детект → письменность
 * (resolveDocLanguage). Дорогой LLM-детект по одиночному source дозаписываем в кэш индекса
 * (persistLanguage) — чтобы не считать язык на каждом поиске. Нет rewrite/модели → undefined.
 */
async function resolveTargetLanguage(
  deps: ToolDeps,
  config: RagConfig,
  indexes: Index[],
  rewriteMode: RewriteMode,
  source: string | null,
  strategy: ChunkStrategy,
): Promise<string | undefined> {
  if (rewriteMode === 'none' || deps.chatComplete === undefined) {
    return undefined;
  }
  const resolved = await resolveDocLanguage({
    override: config.docLanguage,
    cachedLanguage: indexes.find(index => index.language !== undefined)?.language,
    chunks: indexes.flatMap(index => index.chunks),
    chatComplete: deps.chatComplete,
  });
  if (resolved.source === 'model' && source !== null && deps.persistLanguage !== undefined) {
    indexes[0].language = resolved.language;
    deps.persistLanguage(source, strategy, indexes[0]);
  }
  return resolved.language;
}

/**
 * search_docs: ищет релевантные фрагменты по запросу. С source — индексирует его на лету (или
 * берёт из кэша) и ищет в нём; без source — по всем кэшированным индексам. Режимы rerank/rewrite,
 * порог и k можно переопределить аргументами (иначе — из конфига). Возвращает трассу стадий и
 * пронумерованные фрагменты с метками источников.
 */
export async function handleSearchDocs(
  deps: ToolDeps,
  args: Record<string, unknown>,
): Promise<string> {
  const query = stringArg(args.query);
  if (query === null) {
    return 'Нужен непустой query (что искать в документах).';
  }
  const config = deps.config;
  const strategy = resolveStrategy(args.strategy, config.strategy);
  const k = numberArg(args.k) ?? config.k;
  const minScore = minScoreArg(args.minScore) ?? config.minScore;
  const rerankMode = rerankArg(args.rerank) ?? config.rerank;
  const rewriteMode = rewriteArg(args.rewrite) ?? config.rewrite;
  const source = stringArg(args.source);
  try {
    const indexes = source === null ? deps.loadAllCached() : [await deps.ensure(source, strategy)];
    if (indexes.length === 0) {
      return 'Нет source и пустой кэш. Укажите source (github-url / путь / url документации).';
    }
    // Кросс-язычный rewrite: определяем язык корпуса и переводим/генерируем запрос НА НЕГО (иначе
    // русский вопрос плохо матчит английские доки). Только когда rewrite активен и есть chat-модель.
    const targetLanguage = await resolveTargetLanguage(
      deps,
      config,
      indexes,
      rewriteMode,
      source,
      strategy,
    );
    const hooks = buildHooks(deps.chatComplete, rewriteMode, rerankMode, targetLanguage);
    const { results, trace } = await retrieve(
      query,
      indexes,
      {
        k,
        kPre: Math.max(k, config.kPre),
        queryPrefix: config.queryPrefix,
        minScore,
        rerank: rerankMode,
        mmrLambda: config.mmrLambda,
        rerankLlmTop: config.rerankLlmTop,
        confidenceMin: config.confidenceMin,
      },
      deps.embed,
      hooks,
    );
    return formatResults(query, results, { ...trace, rewriteLanguage: targetLanguage });
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
