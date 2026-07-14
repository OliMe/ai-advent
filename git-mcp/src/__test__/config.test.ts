import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadAllowedRepos,
  loadMaxOutputChars,
  cloneCacheDir,
  workingRepositoryRoot,
} from '../index.ts';

describe('loadAllowedRepos', () => {
  it('аргументы и GIT_ALLOWED_REPOS ОБЪЕДИНЯЮТСЯ — клиент, добавляя проект, ничего не отбирает', () => {
    const repos = loadAllowedRepos(
      ['/tmp/from-args'],
      { GIT_ALLOWED_REPOS: '/tmp/from-env' },
      '/tmp/cwd',
    );
    assert.deepEqual(repos, ['/tmp/from-args', '/tmp/cwd', '/tmp/from-env', cloneCacheDir()]);
  });

  it('дефолтный репозиторий — рабочий каталог, а не автоматически добавленный проект', () => {
    // Первый элемент = репозиторий по умолчанию (вызов без repo). Привязка чужого клона не должна
    // делать ЕГО дефолтом — иначе «какая ветка?» отвечает про чужой репозиторий.
    const repos = loadAllowedRepos([], { GIT_ALLOWED_REPOS: '/tmp/a, /tmp/b' }, '/tmp/cwd');
    assert.deepEqual(repos, ['/tmp/cwd', '/tmp/a', '/tmp/b', cloneCacheDir()]);
  });

  it('рабочий каталог и кэш клонов разрешены всегда', () => {
    assert.deepEqual(loadAllowedRepos([], {}, '/tmp/cwd'), ['/tmp/cwd', cloneCacheDir()]);
    assert.ok(loadAllowedRepos(['/tmp/repo'], {}, '/x').includes(cloneCacheDir()));
  });

  it('пустые значения отбрасываются, повторы не дублируются', () => {
    assert.deepEqual(loadAllowedRepos(['  '], { GIT_ALLOWED_REPOS: ' , ' }, '/tmp/cwd'), [
      '/tmp/cwd',
      cloneCacheDir(),
    ]);
    assert.deepEqual(
      loadAllowedRepos(['/tmp/cwd'], { GIT_ALLOWED_REPOS: '/tmp/cwd' }, '/tmp/cwd'),
      ['/tmp/cwd', cloneCacheDir()],
    );
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

describe('workingRepositoryRoot', () => {
  it('поднимается от рабочего каталога до корня репозитория', () => {
    // Клиент запускается из своего пакета (…/ai-advent/llm-cli), а проект — репозиторий над ним:
    // разрешать надо корень, иначе сервер требует подтверждение на собственный проект пользователя.
    const repositories = new Set(['/work/repo/.git']);
    const root = workingRepositoryRoot('/work/repo/llm-cli', path => repositories.has(path));
    assert.equal(root, '/work/repo');
  });

  it('репозитория над каталогом нет — берём сам каталог', () => {
    assert.equal(
      workingRepositoryRoot('/tmp/plain', () => false),
      '/tmp/plain',
    );
  });
});
