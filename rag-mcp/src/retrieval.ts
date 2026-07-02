import { topK } from '../../rag/src/index.ts';
import type { EmbedFn, Index, ScoredChunk } from '../../rag/src/index.ts';
import { mmrRerank } from './mmr.ts';

/** Режим стадии rerank: `none` — как есть (после фильтра), `mmr` — MMR-переранжирование. */
export type RerankMode = 'none' | 'mmr';

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

/**
 * Ретрив релевантных чанков по индексам: эмбеддинг запроса (с префиксом) → косинус top-`kPre` по
 * всем чанкам → фильтр по порогу `minScore` → стадия rerank (`none`/`mmr`) → срез до `k`.
 */
export async function retrieve(
  query: string,
  indexes: Index[],
  options: RetrieveOptions,
  embed: EmbedFn,
): Promise<ScoredChunk[]> {
  const [queryVector] = await embed([`${options.queryPrefix}${query}`]);
  const allChunks = indexes.flatMap(index => index.chunks);
  const preliminary = topK(queryVector, allChunks, options.kPre);
  const filtered =
    options.minScore > 0
      ? preliminary.filter(scored => scored.score >= options.minScore)
      : preliminary;
  const reranked =
    options.rerank === 'mmr' ? mmrRerank(filtered, options.k, options.mmrLambda) : filtered;
  return reranked.slice(0, options.k);
}
