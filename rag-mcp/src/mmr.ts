import type { ScoredChunk } from '../../rag/src/index.ts';
import { cosineSimilarity } from '../../rag/src/index.ts';

/**
 * MMR-переранжирование (Maximal Marginal Relevance): жадно отбирает чанки, балансируя релевантность
 * запросу и новизну относительно уже отобранных (штрафует почти-дубли). `lambda`→1 — чистая
 * релевантность, `lambda`→0 — максимум разнообразия. Оценка близости к запросу берётся из входного
 * `score` (косинус, уже посчитан на стадии topK), близость к отобранным — по эмбеддингам чанков.
 * Возвращает до `limit` чанков в MMR-порядке; исходный `score` сохраняется.
 */
export function mmrRerank(candidates: ScoredChunk[], limit: number, lambda: number): ScoredChunk[] {
  const pool = [...candidates];
  const selected: ScoredChunk[] = [];
  while (pool.length > 0 && selected.length < limit) {
    let bestIndex = 0;
    let bestValue = -Infinity;
    for (let index = 0; index < pool.length; index++) {
      const candidate = pool[index];
      const redundancy = selected.reduce(
        (worst, chosen) =>
          Math.max(worst, cosineSimilarity(candidate.chunk.embedding, chosen.chunk.embedding)),
        0,
      );
      const value = lambda * candidate.score - (1 - lambda) * redundancy;
      if (value > bestValue) {
        bestValue = value;
        bestIndex = index;
      }
    }
    selected.push(pool.splice(bestIndex, 1)[0]);
  }
  return selected;
}
