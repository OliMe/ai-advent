import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sourceKey } from '../index.ts';

describe('sourceKey', () => {
  it('детерминирован; хвостовые слэши/пробелы нормализуются', () => {
    assert.equal(
      sourceKey('https://github.com/o/r', 'structural', 'nomic'),
      sourceKey('https://github.com/o/r', 'structural', 'nomic'),
    );
    assert.equal(
      sourceKey('https://github.com/o/r', 'structural', 'nomic'),
      sourceKey(' https://github.com/o/r/ ', 'structural', 'nomic'),
    );
  });

  it('разная стратегия → разный ключ', () => {
    assert.notEqual(
      sourceKey('https://github.com/o/r', 'structural', 'nomic'),
      sourceKey('https://github.com/o/r', 'fixed', 'nomic'),
    );
  });

  it('разный источник → разный ключ', () => {
    assert.notEqual(sourceKey('a', 'fixed', 'nomic'), sourceKey('b', 'fixed', 'nomic'));
  });

  it('разная схема эмбеддинга → разный ключ', () => {
    assert.notEqual(
      sourceKey('a', 'fixed', 'nomic|search_query: |search_document: '),
      sourceKey('a', 'fixed', 'nomic||'),
    );
  });
});
