import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sourceKey } from '../index.ts';

describe('sourceKey', () => {
  it('детерминирован; хвостовые слэши/пробелы нормализуются', () => {
    assert.equal(
      sourceKey('https://github.com/o/r', 'structural'),
      sourceKey('https://github.com/o/r', 'structural'),
    );
    assert.equal(
      sourceKey('https://github.com/o/r', 'structural'),
      sourceKey(' https://github.com/o/r/ ', 'structural'),
    );
  });

  it('разная стратегия → разный ключ', () => {
    assert.notEqual(
      sourceKey('https://github.com/o/r', 'structural'),
      sourceKey('https://github.com/o/r', 'fixed'),
    );
  });

  it('разный источник → разный ключ', () => {
    assert.notEqual(sourceKey('a', 'fixed'), sourceKey('b', 'fixed'));
  });
});
