import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadAllowedDirs } from '../index.ts';

const env = (values: Record<string, string | undefined>): NodeJS.ProcessEnv =>
  values as NodeJS.ProcessEnv;

describe('loadAllowedDirs', () => {
  it('берёт каталоги из аргументов (приоритет), нормализует', () => {
    assert.deepEqual(loadAllowedDirs(['/tmp/fs-test', ' '], env({ FS_ALLOWED_DIRS: '/other' })), [
      '/tmp/fs-test',
    ]);
  });

  it('если аргументов нет — из FS_ALLOWED_DIRS (через запятую)', () => {
    assert.deepEqual(loadAllowedDirs([], env({ FS_ALLOWED_DIRS: '/tmp/a, /tmp/b' })), [
      '/tmp/a',
      '/tmp/b',
    ]);
  });

  it('ничего не задано → ошибка', () => {
    assert.throws(() => loadAllowedDirs([], env({})), /разрешённый каталог/);
  });
});
