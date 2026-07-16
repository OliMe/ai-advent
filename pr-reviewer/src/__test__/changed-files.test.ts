import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readChangedFiles, fileFromPatch } from '../index.ts';

describe('readChangedFiles', () => {
  it('читает изменённые, пропускает удалённые/бинарные/нечитаемые', () => {
    const files = [
      fileFromPatch('src/a.ts', '@@ -1 +1 @@\n+x', 'modified'),
      fileFromPatch('gone.ts', '', 'removed'),
      fileFromPatch('img.png', '', 'binary'),
      fileFromPatch('src/missing.ts', '@@ -1 +1 @@\n+y', 'modified'),
    ];
    const read = (path: string) => (path === 'src/a.ts' ? 'содержимое a' : null);
    assert.deepEqual(readChangedFiles(files, read), [
      { path: 'src/a.ts', content: 'содержимое a' },
    ]);
  });
});
