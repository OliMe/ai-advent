import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expandHome, normalizeAllowedDirs, isWithinAllowed, classifyPath } from '../index.ts';

describe('expandHome', () => {
  it('разворачивает ~ и ~/путь, прочее не трогает', () => {
    assert.equal(expandHome('~'), homedir());
    assert.equal(expandHome('~/tasks/a.md'), join(homedir(), 'tasks/a.md'));
    assert.equal(expandHome('/tmp/x'), '/tmp/x');
    assert.equal(expandHome('rel/x'), 'rel/x');
  });
});

describe('normalizeAllowedDirs', () => {
  it('приводит к абсолютным путям (с разворотом ~)', () => {
    assert.deepEqual(normalizeAllowedDirs(['~/a', '/tmp/b/']), [join(homedir(), 'a'), '/tmp/b']);
  });
});

describe('isWithinAllowed', () => {
  it('равно корню или вложено — true; сосед-префикс — false', () => {
    assert.equal(isWithinAllowed('/tmp/fs-test', ['/tmp/fs-test']), true);
    assert.equal(isWithinAllowed('/tmp/fs-test/sub/a', ['/tmp/fs-test']), true);
    assert.equal(isWithinAllowed('/tmp/fs-test2/a', ['/tmp/fs-test']), false); // сосед, не вложен
    assert.equal(isWithinAllowed('/etc/passwd', ['/tmp/fs-test']), false);
  });
});

describe('classifyPath', () => {
  const allowed = ['/tmp/fs-test'];

  it('абсолютный внутри песочницы → withinAllowed', () => {
    assert.deepEqual(classifyPath('/tmp/fs-test/a.md', allowed), {
      absolute: '/tmp/fs-test/a.md',
      withinAllowed: true,
    });
  });

  it('относительный — от первого разрешённого каталога', () => {
    assert.deepEqual(classifyPath('sub/a.md', allowed), {
      absolute: '/tmp/fs-test/sub/a.md',
      withinAllowed: true,
    });
  });

  it('разворачивает ~ внутри разрешённого домашнего', () => {
    assert.deepEqual(classifyPath('~/a.md', [homedir()]), {
      absolute: join(homedir(), 'a.md'),
      withinAllowed: true,
    });
  });

  it('обход через .. → вне песочницы (withinAllowed=false)', () => {
    assert.deepEqual(classifyPath('/tmp/fs-test/../etc/passwd', allowed), {
      absolute: '/tmp/etc/passwd',
      withinAllowed: false,
    });
  });

  it('путь снаружи → вне песочницы', () => {
    assert.equal(classifyPath('/etc/passwd', allowed).withinAllowed, false);
  });

  it('пустой allow-list → относительный резолвится от ~ и всё равно вне', () => {
    assert.equal(classifyPath('a.md', []).withinAllowed, false);
  });
});
