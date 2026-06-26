import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  expandHome,
  normalizeAllowedDirs,
  isWithinAllowed,
  resolvePath,
  SandboxError,
} from '../index.ts';

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

describe('resolvePath', () => {
  const allowed = ['/tmp/fs-test'];

  it('абсолютный внутри песочницы', () => {
    assert.equal(resolvePath('/tmp/fs-test/a.md', allowed), '/tmp/fs-test/a.md');
  });

  it('относительный — от первого разрешённого каталога', () => {
    assert.equal(resolvePath('sub/a.md', allowed), '/tmp/fs-test/sub/a.md');
  });

  it('разворачивает ~ внутри разрешённого домашнего', () => {
    assert.equal(resolvePath('~/a.md', [homedir()]), join(homedir(), 'a.md'));
  });

  it('обход через .. → ошибка песочницы', () => {
    assert.throws(() => resolvePath('/tmp/fs-test/../etc/passwd', allowed), SandboxError);
  });

  it('путь снаружи → ошибка песочницы', () => {
    assert.throws(() => resolvePath('/etc/passwd', allowed), SandboxError);
  });

  it('пустой allow-list → относительный резолвится от ~ и всё равно вне → ошибка', () => {
    assert.throws(() => resolvePath('a.md', []), SandboxError);
  });
});
