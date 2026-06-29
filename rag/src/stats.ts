import type { Index } from './types.ts';

/** Статистика индекса для сравнения стратегий чанкинга. */
export interface StrategyStats {
  strategy: string;
  chunkCount: number;
  /** Средний/мин/макс размер чанка (символы). */
  avgSize: number;
  minSize: number;
  maxSize: number;
  /** Сколько чанков имеют непустой section (покрытие метаданными). */
  withSection: number;
}

/** Считает статистику индекса (число чанков, размеры, покрытие метаданными). */
export function computeStats(index: Index): StrategyStats {
  const sizes = index.chunks.map(chunk => chunk.text.length);
  const count = sizes.length;
  const total = sizes.reduce((sum, size) => sum + size, 0);
  return {
    strategy: index.strategy,
    chunkCount: count,
    avgSize: count > 0 ? Math.round(total / count) : 0,
    minSize: count > 0 ? Math.min(...sizes) : 0,
    maxSize: count > 0 ? Math.max(...sizes) : 0,
    withSection: index.chunks.filter(chunk => chunk.section.trim() !== '').length,
  };
}
