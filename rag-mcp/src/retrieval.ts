import { topK } from '../../rag/src/index.ts';
import type { EmbedFn, Index, ScoredChunk } from '../../rag/src/index.ts';

/** Параметры выборки: kPre — до стадии rerank/фильтра, k — итог (после). */
export interface RetrieveOptions {
  k: number;
  kPre: number;
}

/**
 * Стадия rerank/фильтрации — ПОКА проходная (День 22). В Дне 23 сюда встанут порог similarity /
 * эвристики / LLM-rerank; интерфейс `retrieve` при этом не меняется.
 */
export function rerank(scored: ScoredChunk[]): ScoredChunk[] {
  return scored;
}

/**
 * Ретрив релевантных чанков по индексам: эмбеддинг запроса → косинус top-`kPre` по всем чанкам →
 * стадия rerank/фильтра → срез до `k`. Возвращает чанки с оценками близости.
 */
export async function retrieve(
  query: string,
  indexes: Index[],
  options: RetrieveOptions,
  embed: EmbedFn,
): Promise<ScoredChunk[]> {
  const [queryVector] = await embed([query]);
  const allChunks = indexes.flatMap(index => index.chunks);
  const preliminary = topK(queryVector, allChunks, options.kPre);
  return rerank(preliminary).slice(0, options.k);
}
