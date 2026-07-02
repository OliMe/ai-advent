import { topK } from '../../rag/src/index.ts';
import type { EmbedFn, Index, ScoredChunk } from '../../rag/src/index.ts';
import { mmrRerank } from './mmr.ts';

/** Режим стадии rerank: `none` — как есть, `mmr` — MMR, `llm` — LLM/cross-encoder (через хук). */
export type RerankMode = 'none' | 'mmr' | 'llm';

/** Параметры выборки: staged-конвейер эмбеддинг → topK(kPre) → фильтр порога → rerank → срез k. */
export interface RetrieveOptions {
  /** Итог после стадии rerank/фильтра. */
  k: number;
  /** Сколько доставать до стадии rerank/фильтра (kPre ≥ k). */
  kPre: number;
  /** Префикс запроса при эмбеддинге (nomic: «search_query: »); пусто — без префикса. */
  queryPrefix: string;
  /** Порог косинуса: чанки ниже отсекаются (0 — фильтр выключен). */
  minScore: number;
  /** Режим переранжирования. */
  rerank: RerankMode;
  /** Баланс релевантность/разнообразие для MMR (0..1). */
  mmrLambda: number;
}

/** Опциональные хуки конвейера: переписывание запроса и LLM/cross-encoder переранжирование. */
export interface RetrieveHooks {
  /** Переписывание запроса перед эмбеддингом (expand/HyDE). Нет — берётся исходный запрос. */
  rewrite?: (query: string) => Promise<string>;
  /** Переранжирование кандидатов при rerank='llm'. Нет — стадия деградирует до 'none'. */
  rerankLlm?: (query: string, candidates: ScoredChunk[]) => Promise<ScoredChunk[]>;
}

/** Трасса конвейера для наблюдаемости «до/после»: что применялось и сколько чанков на каждой стадии. */
export interface RetrieveTrace {
  /** Применялось ли переписывание запроса. */
  rewritten: boolean;
  /** Кандидатов после topK(kPre). */
  candidates: number;
  /** Порог фильтра (0 — выключен). */
  minScore: number;
  /** Осталось после фильтра порога. */
  afterThreshold: number;
  /** Фактически применённый режим rerank (llm без хука → none). */
  rerank: RerankMode;
  /** Итог после среза k. */
  returned: number;
}

/** Результат ретрива: сами чанки + трасса стадий. */
export interface RetrieveResult {
  results: ScoredChunk[];
  trace: RetrieveTrace;
}

/**
 * Применяет выбранную стадию переранжирования; возвращает результат и фактический режим (llm без
 * подключённого хука вырождается в none).
 */
async function applyRerank(
  query: string,
  filtered: ScoredChunk[],
  options: RetrieveOptions,
  hooks: RetrieveHooks,
): Promise<{ reranked: ScoredChunk[]; effective: RerankMode }> {
  if (options.rerank === 'mmr') {
    return { reranked: mmrRerank(filtered, options.k, options.mmrLambda), effective: 'mmr' };
  }
  if (options.rerank === 'llm' && hooks.rerankLlm) {
    return { reranked: await hooks.rerankLlm(query, filtered), effective: 'llm' };
  }
  return { reranked: filtered, effective: 'none' };
}

/**
 * Ретрив релевантных чанков по индексам: (опц. переписывание запроса) → эмбеддинг с префиксом →
 * косинус top-`kPre` → фильтр по порогу `minScore` → стадия rerank (`none`/`mmr`/`llm`) → срез `k`.
 * Переранжирование судит по ИСХОДНОМУ запросу (не по переписанному тексту эмбеддинга — важно для HyDE).
 * Возвращает результат вместе с трассой стадий (для наблюдаемости «до/после»).
 */
export async function retrieve(
  query: string,
  indexes: Index[],
  options: RetrieveOptions,
  embed: EmbedFn,
  hooks: RetrieveHooks = {},
): Promise<RetrieveResult> {
  const embeddingQuery = hooks.rewrite ? await hooks.rewrite(query) : query;
  const [queryVector] = await embed([`${options.queryPrefix}${embeddingQuery}`]);
  const allChunks = indexes.flatMap(index => index.chunks);
  const preliminary = topK(queryVector, allChunks, options.kPre);
  const filtered =
    options.minScore > 0
      ? preliminary.filter(scored => scored.score >= options.minScore)
      : preliminary;
  const { reranked, effective } = await applyRerank(query, filtered, options, hooks);
  const results = reranked.slice(0, options.k);
  return {
    results,
    trace: {
      rewritten: hooks.rewrite !== undefined,
      candidates: preliminary.length,
      minScore: options.minScore,
      afterThreshold: filtered.length,
      rerank: effective,
      returned: results.length,
    },
  };
}
