import { createHash } from 'node:crypto';
import type { ChunkStrategy } from '../../rag/src/index.ts';

/**
 * Ключ кэша индекса по источнику и стратегии: одинаковый источник с разными стратегиями даёт
 * разные индексы (сосуществуют, можно сравнивать). Источник нормализуется (обрезка, срез
 * хвостовых слэшей) — мелкие различия записи не плодят дубликаты.
 */
export function sourceKey(source: string, strategy: ChunkStrategy): string {
  const normalized = source.trim().replace(/\/+$/, '');
  return createHash('sha1').update(`${strategy}:${normalized}`).digest('hex').slice(0, 16);
}
