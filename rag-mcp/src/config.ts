import { homedir } from 'node:os';
import { join } from 'node:path';
import type { EmbeddingsConfig } from '../../core/src/index.ts';
import type { ChunkStrategy, ChunkOptions } from '../../rag/src/index.ts';

/** Конфигурация RAG-сервера: кэш, стратегия, размеры выборки, чанкинг, эмбеддинги. */
export interface RagConfig {
  /** Каталог кэша индексов (по источнику+стратегии). */
  cacheDir: string;
  /** Стратегия чанкинга по умолчанию (сменяемая; переопределяется аргументом инструмента). */
  strategy: ChunkStrategy;
  /** Сколько чанков отдавать в результат (top-K после стадии rerank/фильтра). */
  k: number;
  /** Сколько доставать до стадии rerank/фильтра (хук Дня 23; по умолчанию = k). */
  kPre: number;
  /** Опции чанкинга. */
  chunk: ChunkOptions;
  /** Глубина веб-обхода при индексации URL. */
  depth: number;
  /** Лимит размера файла при индексации, байт. */
  maxBytes: number;
  /** Конфиг эмбеддингов (по умолчанию Ollama; сменяемо через LLM_EMBEDDINGS_*). */
  embeddings: EmbeddingsConfig;
}

/** Целое ≥ 1 из env или значение по умолчанию. */
function positiveInteger(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 ? value : fallback;
}

/** Целое ≥ 0 из env или значение по умолчанию. */
function nonNegativeInteger(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

/** Собирает конфигурацию RAG-сервера из окружения (с разумными дефолтами под Ollama). */
export function loadRagConfig(env: NodeJS.ProcessEnv): RagConfig {
  const strategy: ChunkStrategy = env.RAG_STRATEGY?.trim() === 'fixed' ? 'fixed' : 'structural';
  const k = positiveInteger(env.RAG_TOP_K, 5);
  const apiKey = env.LLM_EMBEDDINGS_API_KEY?.trim();
  return {
    cacheDir: env.RAG_CACHE_DIR?.trim() || join(homedir(), '.rag-mcp', 'indexes'),
    strategy,
    k,
    kPre: positiveInteger(env.RAG_TOP_K_PRE, k),
    chunk: {
      fixed: {
        size: positiveInteger(env.RAG_CHUNK_SIZE, 2000),
        overlap: positiveInteger(env.RAG_CHUNK_OVERLAP, 256),
      },
      structuralMaxSize: positiveInteger(env.RAG_MAX_SECTION, 2000),
    },
    depth: positiveInteger(env.RAG_CRAWL_DEPTH, 2),
    maxBytes: positiveInteger(env.RAG_MAX_BYTES, 1_000_000),
    embeddings: {
      url: env.LLM_EMBEDDINGS_URL?.trim() || 'http://localhost:11434/v1/embeddings',
      model: env.LLM_EMBEDDINGS_MODEL?.trim() || 'nomic-embed-text',
      ...(apiKey ? { apiKey } : {}),
      requestTimeoutMs: positiveInteger(env.LLM_REQUEST_TIMEOUT_MS, 60_000),
      maxRetries: nonNegativeInteger(env.LLM_MAX_RETRIES, 3),
      retryBaseMs: positiveInteger(env.LLM_RETRY_BASE_MS, 500),
    },
  };
}
