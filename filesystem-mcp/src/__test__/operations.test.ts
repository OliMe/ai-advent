import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { nodeFsIo } from '../index.ts';

describe('nodeFsIo (на временном каталоге)', () => {
  it('write → read → append → list → stat → remove', () => {
    const root = mkdtempSync(join(tmpdir(), 'fsmcp-'));
    try {
      const file = join(root, 'sub', 'note.md');
      nodeFsIo.write(file, 'привет'); // создаёт родительский sub/
      assert.equal(nodeFsIo.read(file), 'привет');
      nodeFsIo.append(file, ' и пока');
      assert.equal(nodeFsIo.read(file), 'привет и пока');

      const entries = nodeFsIo.list(join(root, 'sub'));
      assert.deepEqual(entries, [{ name: 'note.md', kind: 'file' }]);

      assert.equal(nodeFsIo.stat(file), 'file');
      assert.equal(nodeFsIo.stat(join(root, 'sub')), 'dir');
      assert.equal(nodeFsIo.stat(join(root, 'нет')), null);

      // список с подкаталогом и файлом
      mkdirSync(join(root, 'dir2'));
      const top = nodeFsIo.list(root);
      assert.ok(top.some(e => e.name === 'dir2' && e.kind === 'dir'));
      assert.ok(top.some(e => e.name === 'sub' && e.kind === 'dir'));

      nodeFsIo.removeFile(file);
      assert.equal(nodeFsIo.stat(file), null);
      nodeFsIo.removeEmptyDir(join(root, 'dir2'));
      assert.equal(nodeFsIo.stat(join(root, 'dir2')), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
