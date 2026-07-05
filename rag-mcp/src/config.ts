import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig, EmbeddingsConfig } from '../../core/src/index.ts';
import type { ChunkStrategy, ChunkOptions } from '../../rag/src/index.ts';
import type { RerankMode } from './retrieval.ts';
import type { RewriteMode } from './rewrite.ts';

/** Конфигурация RAG-сервера: кэш, стратегия, размеры выборки, чанкинг, эмбеддинги. */
export interface RagConfig {
  /** Каталог кэша индексов (по источнику+стратегии). */
  cacheDir: string;
  /** Стратегия чанкинга по умолчанию (сменяемая; переопределяется аргументом инструмента). */
  strategy: ChunkStrategy;
  /** Сколько чанков отдавать в результат (top-K после стадии rerank/фильтра). */
  k: number;
  /** Сколько доставать до стадии rerank/фильтра (kPre ≥ k; по умолчанию 20). */
  kPre: number;
  /** Порог косинуса: чанки ниже отсекаются на стадии фильтра (0 — выключено). */
  minScore: number;
  /** Порог уверенности: лучший косинус ниже — контекст помечается «низкая уверенность» (для «не знаю»). */
  confidenceMin: number;
  /** Режим переранжирования (none/mmr/llm). */
  rerank: RerankMode;
  /** Баланс релевантность/разнообразие для MMR (0..1). */
  mmrLambda: number;
  /** Сколько верхних кандидатов подавать в LLM-реранк (короткий список — надёжный ответ модели). */
  rerankLlmTop: number;
  /** Режим переписывания запроса (none/expand/hyde). */
  rewrite: RewriteMode;
  /**
   * Явный язык документации (английское название, напр. `English`) — оверрайд автоопределения по
   * индексу для кросс-язычного rewrite. Пусто — определяем сами (кэш индекса → LLM → письменность).
   */
  docLanguage: string | undefined;
  /** Chat-модель для rewrite/LLM-реранка (RAG_LLM_* с фолбэком на LLM_*); null — фичи выключены. */
  chat: AppConfig | null;
  /** Отключать «рассуждения» chat-модели (нужно для GLM). */
  chatDisableThinking: boolean;
  /** Опции чанкинга. */
  chunk: ChunkOptions;
  /** Глубина веб-обхода при индексации URL. */
  depth: number;
  /** Лимит размера файла при индексации, байт. */
  maxBytes: number;
  /** Конфиг эмбеддингов (по умолчанию Ollama; сменяемо через LLM_EMBEDDINGS_*). */
  embeddings: EmbeddingsConfig;
  /** Префикс запроса при эмбеддинге (nomic: «search_query: »); пусто — без префикса. */
  queryPrefix: string;
  /** Префикс документа при эмбеддинге (nomic: «search_document: »); пусто — без префикса. */
  docPrefix: string;
}

/**
 * «Схема» эмбеддинга: модель + префиксы. Входит в ключ кэша, чтобы индексы, построенные разными
 * схемами (напр. без префиксов), не переиспользовались с новой — иначе векторы несопоставимы.
 */
export function embeddingScheme(config: RagConfig): string {
  return `${config.embeddings.model}|${config.queryPrefix}|${config.docPrefix}`;
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

/** Дробное число в диапазоне [min, max] из env или значение по умолчанию. */
function boundedNumber(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = Number(raw);
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

/** Первое непустое (trim) значение из перечня переменных окружения или undefined. */
function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

/** Режим переписывания запроса из env (expand/hyde) или none по умолчанию. */
function resolveRewrite(raw: string | undefined): RewriteMode {
  const value = raw?.trim();
  return value === 'expand' || value === 'hyde' ? value : 'none';
}

/** Режим переранжирования из env (none/llm) или mmr по умолчанию. */
function resolveRerank(raw: string | undefined): RerankMode {
  const value = raw?.trim();
  return value === 'none' || value === 'llm' ? value : 'mmr';
}

/**
 * Собирает конфиг chat-модели для rewrite/LLM-реранка: сначала RAG_LLM_*, затем фолбэк на ядровые
 * LLM_*. Если url/model/ключ так и не набрались — возвращает null (фичи с LLM просто выключаются).
 */
export function loadChatConfig(env: NodeJS.ProcessEnv): AppConfig | null {
  const apiKey = firstNonEmpty(env.RAG_LLM_API_KEY, env.LLM_API_KEY);
  const baseUrl = firstNonEmpty(env.RAG_LLM_BASE_URL, env.LLM_BASE_URL);
  const model = firstNonEmpty(env.RAG_LLM_MODEL, env.LLM_MODEL);
  if (!apiKey || !baseUrl || !model) {
    return null;
  }
  return {
    apiKey,
    baseUrl,
    model,
    // Низкая температура — стабильнее для reranking и переписывания запроса.
    temperature: boundedNumber(env.RAG_LLM_TEMPERATURE, 0.2, 0, 2),
    systemPrompt: '',
    requestTimeoutMs: positiveInteger(env.LLM_REQUEST_TIMEOUT_MS, 60_000),
    contextTokens: positiveInteger(env.LLM_CONTEXT_TOKENS, 8192),
    maxRetries: nonNegativeInteger(env.LLM_MAX_RETRIES, 3),
    retryBaseMs: positiveInteger(env.LLM_RETRY_BASE_MS, 500),
    priceInputPer1M: 0,
    priceOutputPer1M: 0,
    usdToRub: 90,
    maxStageAgents: 4,
    stageAgentConcurrency: 2,
    maxToolRounds: 12,
  };
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
    kPre: positiveInteger(env.RAG_TOP_K_PRE, 20),
    minScore: boundedNumber(env.RAG_MIN_SCORE, 0, 0, 1),
    confidenceMin: boundedNumber(env.RAG_CONFIDENCE_MIN, 0.6, 0, 1),
    rerank: resolveRerank(env.RAG_RERANK),
    mmrLambda: boundedNumber(env.RAG_MMR_LAMBDA, 0.7, 0, 1),
    rerankLlmTop: positiveInteger(env.RAG_RERANK_LLM_TOP, 8),
    rewrite: resolveRewrite(env.RAG_REWRITE),
    docLanguage: env.RAG_DOC_LANG?.trim() || undefined,
    chat: loadChatConfig(env),
    chatDisableThinking:
      env.RAG_LLM_NO_THINKING?.trim() === '1' || env.RAG_LLM_NO_THINKING?.trim() === 'true',
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
    // Пустая строка в env отключает префикс (для моделей, которым он не нужен) — поэтому
    // проверяем именно undefined, а не «||» (иначе '' откатывалось бы к дефолту).
    queryPrefix: env.RAG_QUERY_PREFIX !== undefined ? env.RAG_QUERY_PREFIX : 'search_query: ',
    docPrefix: env.RAG_DOC_PREFIX !== undefined ? env.RAG_DOC_PREFIX : 'search_document: ',
  };
}
