import type { ChunkOptions } from './chunkers.ts';
import { chunkDocument } from './chunkers.ts';
import type { ChunkStrategy, Document, Index, IndexedChunk } from './types.ts';

/** Функция эмбеддинга набора текстов (обычно `EmbeddingsClient.embed`; инжектируется). */
export type EmbedFn = (inputs: string[]) => Promise<number[][]>;

/** Параметры сборки индекса. */
export interface BuildOptions {
  strategy: ChunkStrategy;
  chunk: ChunkOptions;
  embed: EmbedFn;
  /** Имя модели эмбеддингов (в метаданные индекса). */
  model: string;
  /** Момент сборки (ISO) — передаётся вызывающим (в логике времени нет). */
  createdAt: string;
  /** Размер батча эмбеддингов. По умолчанию 64. */
  batchSize?: number;
}

/**
 * Строит индекс: режет документы выбранной стратегией, эмбеддит чанки батчами и собирает
 * записи с метаданными. Размерность берётся из первого вектора (0 — если чанков нет).
 */
export async function buildIndex(documents: Document[], options: BuildOptions): Promise<Index> {
  const chunks = documents.flatMap(doc => chunkDocument(doc, options.strategy, options.chunk));
  const batchSize = options.batchSize ?? 64;
  const indexed: IndexedChunk[] = [];
  for (let start = 0; start < chunks.length; start += batchSize) {
    const batch = chunks.slice(start, start + batchSize);
    const vectors = await options.embed(batch.map(chunk => chunk.text));
    batch.forEach((chunk, position) => indexed.push({ ...chunk, embedding: vectors[position] }));
  }
  return {
    strategy: options.strategy,
    model: options.model,
    dimensions: indexed.length > 0 ? indexed[0].embedding.length : 0,
    createdAt: options.createdAt,
    chunks: indexed,
  };
}
