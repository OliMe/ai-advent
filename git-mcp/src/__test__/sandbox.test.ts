import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  expandHome,
  normalizeAllowedRepos,
  isWithinAllowed,
  classifyPath,
  resolveInsideRepo,
} from '../index.ts';

describe('expandHome', () => {
  it('одиночная тильда — домашний каталог', () => {
    assert.equal(expandHome('~'), homedir());
  });

  it('тильда со слэшем разворачивается', () => {
    assert.equal(expandHome('~/projects'), join(homedir(), 'projects'));
  });

  it('обычный путь не меняется', () => {
    assert.equal(expandHome('/tmp/repo'), '/tmp/repo');
  });
});

describe('normalizeAllowedRepos / isWithinAllowed', () => {
  it('приводит к абсолютным путям', () => {
    assert.deepEqual(normalizeAllowedRepos(['/tmp/repo/']), ['/tmp/repo']);
  });

  it('путь внутри разрешённого или равный ему', () => {
    assert.ok(isWithinAllowed('/tmp/repo', ['/tmp/repo']));
    assert.ok(isWithinAllowed('/tmp/repo/src/a.ts', ['/tmp/repo']));
  });

  it('путь снаружи не разрешён (в том числе похожий префикс)', () => {
    assert.equal(isWithinAllowed('/tmp/other', ['/tmp/repo']), false);
    assert.equal(isWithinAllowed('/tmp/repo-evil', ['/tmp/repo']), false);
  });
});

describe('classifyPath', () => {
  it('абсолютный путь внутри allow-list', () => {
    assert.deepEqual(classifyPath('/tmp/repo/src', ['/tmp/repo']), {
      absolute: '/tmp/repo/src',
      withinAllowed: true,
    });
  });

  it('относительный путь резолвится от первого разрешённого репозитория', () => {
    assert.deepEqual(classifyPath('src', ['/tmp/repo']), {
      absolute: '/tmp/repo/src',
      withinAllowed: true,
    });
  });

  it('пустой allow-list → база домашний каталог, путь снаружи', () => {
    const classified = classifyPath('project', []);
    assert.equal(classified.absolute, join(homedir(), 'project'));
    assert.equal(classified.withinAllowed, false);
  });

  it('путь вне allow-list распознан, но не отклонён', () => {
    assert.deepEqual(classifyPath('/etc', ['/tmp/repo']), {
      absolute: '/etc',
      withinAllowed: false,
    });
  });
});

describe('resolveInsideRepo', () => {
  it('относительный путь — от корня репозитория', () => {
    assert.equal(resolveInsideRepo('/tmp/repo', 'src/a.ts'), '/tmp/repo/src/a.ts');
  });

  it('тильда разворачивается', () => {
    const inside = resolve(homedir(), 'x.ts');
    assert.equal(resolveInsideRepo(homedir(), '~/x.ts'), inside);
  });

  it('выход за пределы репозитория запрещён', () => {
    assert.equal(resolveInsideRepo('/tmp/repo', '../../etc/passwd'), null);
    assert.equal(resolveInsideRepo('/tmp/repo', '/etc/passwd'), null);
  });
});
