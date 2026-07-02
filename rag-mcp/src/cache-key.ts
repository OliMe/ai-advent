import { createHash } from 'node:crypto';
import type { ChunkStrategy } from '../../rag/src/index.ts';

/**
 * Ключ кэша индекса по источнику, стратегии и «схеме» эмбеддинга (модель+префиксы). Разные
 * стратегии/схемы дают разные индексы (сосуществуют, не переиспользуются с несовместимой схемой).
 * Источник нормализуется (обрезка, срез хвостовых слэшей) — мелкие различия записи не плодят дубли.
 */
export function sourceKey(source: string, strategy: ChunkStrategy, scheme: string): string {
  const normalized = source.trim().replace(/\/+$/, '');
  return createHash('sha1')
    .update(`${scheme}:${strategy}:${normalized}`)
    .digest('hex')
    .slice(0, 16);
}
