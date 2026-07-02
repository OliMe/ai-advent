import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadRagConfig, embeddingScheme } from '../index.ts';

const env = (values: Record<string, string | undefined>): NodeJS.ProcessEnv =>
  values as NodeJS.ProcessEnv;

describe('loadRagConfig', () => {
  it('дефолты: structural, k=kPre=5, Ollama-эмбеддинги без ключа', () => {
    const config = loadRagConfig(env({}));
    assert.equal(config.strategy, 'structural');
    assert.equal(config.k, 5);
    assert.equal(config.kPre, 5);
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

  it('kPre по умолчанию равен k', () => {
    assert.equal(loadRagConfig(env({ RAG_TOP_K: '8' })).kPre, 8);
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
