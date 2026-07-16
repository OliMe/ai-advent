/**
 * Точка входа ассистента поддержки (тонкая проводка, вне покрытия). Пока — ветка `--warm-cache`:
 * собрать индекс FAQ в кэш и выйти (нужен только эмбеддер). Полный поток ответа — инкремент 4.
 * Диагностика идёт в stderr.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadEmbeddingsConfig, EmbeddingsClient } from '../../core/src/index.ts';
import { loadLocalDocuments, nodeLocalIo } from '../../rag/src/index.ts';
import { warmDocsIndex, FileIndexCache } from '../../grounding/src/index.ts';
import type { IndexCacheIo } from '../../grounding/src/index.ts';
import { loadSupportBotConfig } from './config.ts';

/** Флаг присутствует в argv. */
function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const packageDir = join(import.meta.dirname, '..');
  const config = loadSupportBotConfig(process.env, packageDir);

  const embeddingsConfig = loadEmbeddingsConfig(process.env);
  const embeddings = new EmbeddingsClient(embeddingsConfig);

  const cacheIo: IndexCacheIo = {
    read(path) {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    },
    write(path, content) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    },
  };
  const cache = new FileIndexCache(config.cacheDir, cacheIo);
  const docs = loadLocalDocuments(config.faqDir, nodeLocalIo);

  if (hasFlag(argv, '--warm-cache')) {
    // Строгий прогрев: ошибка/таймаут эмбеддера пробрасывается (job в CI покраснеет).
    const chunkCount = await warmDocsIndex({
      embed: inputs => embeddings.embed(inputs),
      loadDocs: () => docs,
      now: new Date().toISOString(),
      topKCount: 1,
      cache,
      embeddingId: embeddingsConfig.model,
    });
    console.error(
      `FAQ-индекс прогрет: ${docs.length} документов, ${chunkCount} чанков → ${config.cacheDir}`,
    );
    return;
  }

  console.error('support-bot: укажите --warm-cache (полный поток ответа — инкремент 4).');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
