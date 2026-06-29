import type { IndexedChunk } from './types.ts';

/** Косинусная близость двух векторов; нулевой вектор → 0 (без деления на ноль). */
export function cosineSimilarity(first: number[], second: number[]): number {
  let dot = 0;
  let normFirst = 0;
  let normSecond = 0;
  for (let i = 0; i < first.length; i++) {
    dot += first[i] * second[i];
    normFirst += first[i] * first[i];
    normSecond += second[i] * second[i];
  }
  const denominator = Math.sqrt(normFirst) * Math.sqrt(normSecond);
  return denominator === 0 ? 0 : dot / denominator;
}

/** Чанк с оценкой близости к запросу. */
export interface ScoredChunk {
  chunk: IndexedChunk;
  score: number;
}

/** Top-k ближайших к запросу чанков (по косинусу), по убыванию близости. */
export function topK(queryVector: number[], chunks: IndexedChunk[], k: number): ScoredChunk[] {
  return chunks
    .map(chunk => ({ chunk, score: cosineSimilarity(queryVector, chunk.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
