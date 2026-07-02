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

/** Применяет выбранную стадию переранжирования к отфильтрованным кандидатам. */
async function applyRerank(
  query: string,
  filtered: ScoredChunk[],
  options: RetrieveOptions,
  hooks: RetrieveHooks,
): Promise<ScoredChunk[]> {
  if (options.rerank === 'mmr') {
    return mmrRerank(filtered, options.k, options.mmrLambda);
  }
  if (options.rerank === 'llm' && hooks.rerankLlm) {
    return hooks.rerankLlm(query, filtered);
  }
  return filtered;
}

/**
 * Ретрив релевантных чанков по индексам: (опц. переписывание запроса) → эмбеддинг с префиксом →
 * косинус top-`kPre` → фильтр по порогу `minScore` → стадия rerank (`none`/`mmr`/`llm`) → срез `k`.
 * Переранжирование судит по ИСХОДНОМУ запросу (не по переписанному тексту эмбеддинга — важно для HyDE).
 */
export async function retrieve(
  query: string,
  indexes: Index[],
  options: RetrieveOptions,
  embed: EmbedFn,
  hooks: RetrieveHooks = {},
): Promise<ScoredChunk[]> {
  const embeddingQuery = hooks.rewrite ? await hooks.rewrite(query) : query;
  const [queryVector] = await embed([`${options.queryPrefix}${embeddingQuery}`]);
  const allChunks = indexes.flatMap(index => index.chunks);
  const preliminary = topK(queryVector, allChunks, options.kPre);
  const filtered =
    options.minScore > 0
      ? preliminary.filter(scored => scored.score >= options.minScore)
      : preliminary;
  const reranked = await applyRerank(query, filtered, options, hooks);
  return reranked.slice(0, options.k);
}
