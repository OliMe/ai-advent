import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadAllowedRepos, loadMaxOutputChars, cloneCacheDir } from '../index.ts';

describe('loadAllowedRepos', () => {
  it('позиционные аргументы приоритетнее переменной окружения', () => {
    const repos = loadAllowedRepos(
      ['/tmp/from-args'],
      { GIT_ALLOWED_REPOS: '/tmp/from-env' },
      '/x',
    );
    assert.deepEqual(repos, ['/tmp/from-args', cloneCacheDir()]);
  });

  it('без аргументов берётся GIT_ALLOWED_REPOS (через запятую)', () => {
    const repos = loadAllowedRepos([], { GIT_ALLOWED_REPOS: '/tmp/a, /tmp/b' }, '/x');
    assert.deepEqual(repos, ['/tmp/a', '/tmp/b', cloneCacheDir()]);
  });

  it('без аргументов и переменной берётся текущий каталог', () => {
    assert.deepEqual(loadAllowedRepos([], {}, '/tmp/cwd'), ['/tmp/cwd', cloneCacheDir()]);
  });

  it('пустые значения отбрасываются', () => {
    assert.deepEqual(loadAllowedRepos(['  '], { GIT_ALLOWED_REPOS: ' , ' }, '/tmp/cwd'), [
      '/tmp/cwd',
      cloneCacheDir(),
    ]);
  });

  it('кэш клонов разрешён всегда', () => {
    assert.ok(loadAllowedRepos(['/tmp/repo'], {}, '/x').includes(cloneCacheDir()));
  });
});

describe('loadMaxOutputChars', () => {
  it('дефолт без переменной', () => {
    assert.equal(loadMaxOutputChars({}), 8000);
  });

  it('число из переменной', () => {
    assert.equal(loadMaxOutputChars({ GIT_MAX_OUTPUT_CHARS: '1500' }), 1500);
  });

  it('невалидное и неположительное — дефолт', () => {
    assert.equal(loadMaxOutputChars({ GIT_MAX_OUTPUT_CHARS: 'много' }), 8000);
    assert.equal(loadMaxOutputChars({ GIT_MAX_OUTPUT_CHARS: '0' }), 8000);
  });
});
