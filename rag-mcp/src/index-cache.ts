import type { ChunkStrategy, Index } from '../../rag/src/index.ts';
import { sourceKey } from './cache-key.ts';

/** Ввод-вывод кэша индексов (инжектируется; реальный — поверх fs + сборки индекса). */
export interface CacheDeps {
  /** Есть ли в кэше индекс с этим ключом. */
  has(key: string): boolean;
  /** Загрузить индекс из кэша по ключу. */
  load(key: string): Index;
  /** Построить индекс источника выбранной стратегией (загрузка → чанкинг → эмбеддинги). */
  build(source: string, strategy: ChunkStrategy): Promise<Index>;
  /** Сохранить индекс в кэш под ключом. */
  save(key: string, index: Index): void;
}

/**
 * Гарантирует наличие индекса для источника+стратегии: есть в кэше — берём оттуда; нет — строим
 * на лету и кэшируем. Возвращает готовый индекс.
 */
export async function ensureIndex(
  source: string,
  strategy: ChunkStrategy,
  deps: CacheDeps,
): Promise<Index> {
  const key = sourceKey(source, strategy);
  if (deps.has(key)) {
    return deps.load(key);
  }
  const index = await deps.build(source, strategy);
  deps.save(key, index);
  return index;
}
