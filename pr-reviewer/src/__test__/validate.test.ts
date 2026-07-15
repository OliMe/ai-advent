import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateFindings, fileFromPatch } from '../index.ts';
import type { Finding } from '../index.ts';

const PATCH = ['@@ -1,1 +1,2 @@', ' ctx', '+added'].join('\n'); // комментируемы строки 1 и 2

const finding = (file: string, line: number): Finding => ({
  file,
  line,
  severity: 'bug',
  title: 'т',
  body: 'б',
});

describe('validateFindings', () => {
  it('на реальную комментируемую строку — inline, иначе — general', () => {
    const files = [fileFromPatch('src/a.ts', PATCH, 'modified')];
    const { inline, general } = validateFindings(
      [
        finding('src/a.ts', 2), // добавленная строка — inline
        finding('src/a.ts', 1), // контекстная строка — inline
        finding('src/a.ts', 99), // строки нет в diff — general
        finding('other.ts', 2), // файла нет в изменённых — general
      ],
      files,
    );
    assert.deepEqual(
      inline.map(f => f.line),
      [2, 1],
    );
    assert.deepEqual(
      general.map(f => `${f.file}:${f.line}`),
      ['src/a.ts:99', 'other.ts:2'],
    );
  });

  it('нет находок — пустые списки', () => {
    assert.deepEqual(validateFindings([], []), { inline: [], general: [] });
  });
});
