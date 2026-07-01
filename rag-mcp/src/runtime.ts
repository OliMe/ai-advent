/**
 * Реальные зависимости RAG-сервера: EmbeddingsClient + загрузка/сборка индексов (пакет rag) +
 * файловый кэш. Только проводка — исключён из покрытия; вся логика в config/retrieval/cache/tools.
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { EmbeddingsClient } from '../../core/src/index.ts';
import { buildIndex, loadDocuments, nodeLoaders, JsonIndexStore } from '../../rag/src/index.ts';
import type { ChunkStrategy, Index } from '../../rag/src/index.ts';
import type { RagConfig } from './config.ts';
import { ensureIndex } from './index-cache.ts';
import type { ToolDeps } from './tools.ts';

/** Путь к файлу индекса в кэше по ключу. */
function indexPath(cacheDir: string, key: string): string {
  return join(cacheDir, `${key}.json`);
}

/** Собирает боевые ToolDeps: эмбеддинги, индексация на лету, файловый кэш. */
export function createRuntimeDeps(config: RagConfig): ToolDeps {
  const client = new EmbeddingsClient(config.embeddings);
  const embed = (inputs: string[]) => client.embed(inputs);
  const loaders = nodeLoaders({ depth: config.depth, maxBytes: config.maxBytes });

  const ensure = (source: string, strategy: ChunkStrategy): Promise<Index> =>
    ensureIndex(source, strategy, {
      has: key => existsSync(indexPath(config.cacheDir, key)),
      load: key => new JsonIndexStore(indexPath(config.cacheDir, key)).load(),
      save: (key, index) => {
        mkdirSync(config.cacheDir, { recursive: true });
        new JsonIndexStore(indexPath(config.cacheDir, key)).save(index);
      },
      build: async (src, strat) => {
        const documents = await loadDocuments(src, loaders);
        return buildIndex(documents, {
          strategy: strat,
          chunk: config.chunk,
          embed,
          model: config.embeddings.model,
          createdAt: new Date().toISOString(),
        });
      },
    });

  const loadAllCached = (): Index[] => {
    if (!existsSync(config.cacheDir)) {
      return [];
    }
    return readdirSync(config.cacheDir)
      .filter(name => name.endsWith('.json'))
      .map(name => new JsonIndexStore(join(config.cacheDir, name)).load());
  };

  return { config, embed, ensure, loadAllCached };
}
