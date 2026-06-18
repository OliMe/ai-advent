import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatAttachment, attachFiles, combinePrompt } from '../index.ts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('formatAttachment / attachFiles / combinePrompt', () => {
  it('formatAttachment оформляет содержимое с пометкой и кодоблоком', () => {
    const text = formatAttachment('a.ts', 'код');
    assert.match(text, /Содержимое файла «a\.ts»/);
    assert.match(text, /```\nкод\n```/);
  });

  it('attachFiles читает несколько файлов и склеивает их', () => {
    const dir = mkdtempSync(join(tmpdir(), 'llm-files-'));
    try {
      writeFileSync(join(dir, 'a.txt'), 'AAA');
      writeFileSync(join(dir, 'b.txt'), 'BBB');
      const result = attachFiles([join(dir, 'a.txt'), join(dir, 'b.txt')]);
      assert.match(result, /AAA/);
      assert.match(result, /BBB/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('attachFiles бросает понятную ошибку для отсутствующего файла', () => {
    assert.throws(() => attachFiles(['/нет/такого.txt']), /Не удалось прочитать файл/);
  });

  it('combinePrompt: вложения+промпт, только вложения, только промпт, пусто', () => {
    assert.equal(combinePrompt('Ф', 'П'), 'Ф\n\nП');
    assert.equal(combinePrompt('Ф', ''), 'Ф');
    assert.equal(combinePrompt('', 'П'), 'П');
    assert.equal(combinePrompt('', ''), '');
  });
});
