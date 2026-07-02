import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { packageEnvPath, loadPackageEnv } from '../index.ts';

describe('packageEnvPath', () => {
  it('указывает на .env рядом с пакетом (на уровень выше каталога модуля)', () => {
    assert.equal(packageEnvPath('/a/b/src'), '/a/b/.env');
    assert.equal(packageEnvPath('/root/rag-mcp/src'), '/root/rag-mcp/.env');
  });
});

describe('loadPackageEnv', () => {
  it('зовёт загрузчик с путём к .env пакета', () => {
    const paths: string[] = [];
    loadPackageEnv('/pkg/src', path => paths.push(path));
    assert.deepEqual(paths, ['/pkg/.env']);
  });

  it('глотает ошибку загрузчика (нет файла — не падаем)', () => {
    assert.doesNotThrow(() =>
      loadPackageEnv('/pkg/src', () => {
        throw new Error('ENOENT');
      }),
    );
  });
});
