import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadRagConfig, loadChatConfig, embeddingScheme } from '../index.ts';

const env = (values: Record<string, string | undefined>): NodeJS.ProcessEnv =>
  values as NodeJS.ProcessEnv;

describe('loadRagConfig', () => {
  it('дефолты: structural, k=5, kPre=20, mmr/порог, Ollama-эмбеддинги без ключа', () => {
    const config = loadRagConfig(env({}));
    assert.equal(config.strategy, 'structural');
    assert.equal(config.k, 5);
    assert.equal(config.kPre, 20);
    assert.equal(config.minScore, 0);
    assert.equal(config.rerank, 'mmr');
    assert.equal(config.mmrLambda, 0.7);
    assert.equal(config.rerankLlmTop, 8);
    assert.match(config.cacheDir, /\.rag-mcp\/indexes$/);
    assert.equal(config.embeddings.url, 'http://localhost:11434/v1/embeddings');
    assert.equal(config.embeddings.model, 'nomic-embed-text');
    assert.equal(config.embeddings.apiKey, undefined);
    assert.deepEqual(config.chunk, {
      fixed: { size: 2000, overlap: 256 },
      structuralMaxSize: 2000,
    });
    assert.equal(config.queryPrefix, 'search_query: ');
    assert.equal(config.docPrefix, 'search_document: ');
    assert.equal(config.rewrite, 'none');
    assert.equal(config.chat, null); // без LLM_*/RAG_LLM_* фичи с моделью выключены
    assert.equal(config.chatDisableThinking, false);
  });

  it('rewrite/rerank=llm переопределяются; нераспознанный rewrite → none', () => {
    assert.equal(loadRagConfig(env({ RAG_REWRITE: 'expand' })).rewrite, 'expand');
    assert.equal(loadRagConfig(env({ RAG_REWRITE: 'hyde' })).rewrite, 'hyde');
    assert.equal(loadRagConfig(env({ RAG_REWRITE: 'wat' })).rewrite, 'none');
    assert.equal(loadRagConfig(env({ RAG_RERANK: 'llm' })).rerank, 'llm');
  });

  it('chatDisableThinking включается по 1/true', () => {
    assert.equal(loadRagConfig(env({ RAG_LLM_NO_THINKING: '1' })).chatDisableThinking, true);
    assert.equal(loadRagConfig(env({ RAG_LLM_NO_THINKING: 'true' })).chatDisableThinking, true);
    assert.equal(loadRagConfig(env({ RAG_LLM_NO_THINKING: 'no' })).chatDisableThinking, false);
  });

  it('префиксы nomic переопределяются; пустая строка отключает префикс', () => {
    const custom = loadRagConfig(env({ RAG_QUERY_PREFIX: 'q: ', RAG_DOC_PREFIX: 'd: ' }));
    assert.equal(custom.queryPrefix, 'q: ');
    assert.equal(custom.docPrefix, 'd: ');
    const disabled = loadRagConfig(env({ RAG_QUERY_PREFIX: '', RAG_DOC_PREFIX: '' }));
    assert.equal(disabled.queryPrefix, '');
    assert.equal(disabled.docPrefix, '');
  });

  it('embeddingScheme = модель|queryPrefix|docPrefix (различает схемы)', () => {
    const withPrefixes = loadRagConfig(env({}));
    const withoutPrefixes = loadRagConfig(env({ RAG_QUERY_PREFIX: '', RAG_DOC_PREFIX: '' }));
    assert.equal(
      embeddingScheme(withPrefixes),
      'nomic-embed-text|search_query: |search_document: ',
    );
    assert.notEqual(embeddingScheme(withPrefixes), embeddingScheme(withoutPrefixes));
  });

  it('RAG_STRATEGY=fixed → fixed', () => {
    assert.equal(loadRagConfig(env({ RAG_STRATEGY: 'fixed' })).strategy, 'fixed');
  });

  it('kPre по умолчанию 20 независимо от k', () => {
    assert.equal(loadRagConfig(env({ RAG_TOP_K: '8' })).kPre, 20);
  });

  it('rerank/порог/lambda переопределяются; невалидные → дефолты', () => {
    const custom = loadRagConfig(
      env({ RAG_RERANK: 'none', RAG_MIN_SCORE: '0.4', RAG_MMR_LAMBDA: '0.5' }),
    );
    assert.equal(custom.rerank, 'none');
    assert.equal(custom.minScore, 0.4);
    assert.equal(custom.mmrLambda, 0.5);
    // Нераспознанный режим → дефолт mmr; порог/лямбда вне [0,1] → дефолты.
    const bad = loadRagConfig(env({ RAG_RERANK: 'wat', RAG_MIN_SCORE: '2', RAG_MMR_LAMBDA: '-1' }));
    assert.equal(bad.rerank, 'mmr');
    assert.equal(bad.minScore, 0);
    assert.equal(bad.mmrLambda, 0.7);
  });

  it('rerankLlmTop переопределяется; невалидный → дефолт 8', () => {
    assert.equal(loadRagConfig(env({ RAG_RERANK_LLM_TOP: '5' })).rerankLlmTop, 5);
    assert.equal(loadRagConfig(env({ RAG_RERANK_LLM_TOP: '0' })).rerankLlmTop, 8);
  });

  it('переопределения из окружения (в т.ч. эмбеддинги и kPre)', () => {
    const config = loadRagConfig(
      env({
        RAG_CACHE_DIR: '/tmp/idx',
        RAG_TOP_K: '8',
        RAG_TOP_K_PRE: '20',
        RAG_CHUNK_SIZE: '1000',
        RAG_CHUNK_OVERLAP: '100',
        RAG_MAX_SECTION: '1500',
        RAG_CRAWL_DEPTH: '3',
        RAG_MAX_BYTES: '500000',
        LLM_EMBEDDINGS_URL: 'https://api/emb',
        LLM_EMBEDDINGS_MODEL: 'text-embed',
        LLM_EMBEDDINGS_API_KEY: 'key',
      }),
    );
    assert.equal(config.cacheDir, '/tmp/idx');
    assert.equal(config.k, 8);
    assert.equal(config.kPre, 20);
    assert.deepEqual(config.chunk, {
      fixed: { size: 1000, overlap: 100 },
      structuralMaxSize: 1500,
    });
    assert.equal(config.depth, 3);
    assert.equal(config.maxBytes, 500_000);
    assert.deepEqual(config.embeddings, {
      url: 'https://api/emb',
      model: 'text-embed',
      apiKey: 'key',
      requestTimeoutMs: 60_000,
      maxRetries: 3,
      retryBaseMs: 500,
    });
  });

  it('невалидные числа → дефолты; валидный ноль повторов принимается', () => {
    const bad = loadRagConfig(env({ RAG_TOP_K: 'abc', LLM_MAX_RETRIES: '-1' }));
    assert.equal(bad.k, 5);
    assert.equal(bad.embeddings.maxRetries, 3);
    assert.equal(loadRagConfig(env({ LLM_MAX_RETRIES: '0' })).embeddings.maxRetries, 0);
  });
});

describe('loadChatConfig', () => {
  it('без url/model/ключа → null', () => {
    assert.equal(loadChatConfig(env({})), null);
    assert.equal(
      loadChatConfig(env({ LLM_BASE_URL: 'https://api', LLM_MODEL: 'm' })), // нет ключа
      null,
    );
  });

  it('фолбэк на ядровые LLM_*', () => {
    const config = loadChatConfig(
      env({ LLM_API_KEY: 'k', LLM_BASE_URL: 'https://api', LLM_MODEL: 'glm' }),
    );
    assert.ok(config);
    assert.equal(config.apiKey, 'k');
    assert.equal(config.baseUrl, 'https://api');
    assert.equal(config.model, 'glm');
    assert.equal(config.temperature, 0.2); // дефолт для reranking/rewrite
  });

  it('RAG_LLM_* имеют приоритет над LLM_*; своя температура', () => {
    const config = loadChatConfig(
      env({
        LLM_API_KEY: 'core',
        LLM_BASE_URL: 'https://core',
        LLM_MODEL: 'core-model',
        RAG_LLM_API_KEY: 'rag',
        RAG_LLM_BASE_URL: 'https://rag',
        RAG_LLM_MODEL: 'rag-model',
        RAG_LLM_TEMPERATURE: '0.5',
      }),
    );
    assert.ok(config);
    assert.equal(config.apiKey, 'rag');
    assert.equal(config.baseUrl, 'https://rag');
    assert.equal(config.model, 'rag-model');
    assert.equal(config.temperature, 0.5);
  });

  it('loadRagConfig.chat собирается, когда заданы LLM_*', () => {
    const config = loadRagConfig(
      env({ LLM_API_KEY: 'k', LLM_BASE_URL: 'https://api', LLM_MODEL: 'm' }),
    );
    assert.ok(config.chat);
    assert.equal(config.chat.model, 'm');
  });
});
