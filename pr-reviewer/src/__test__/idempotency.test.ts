import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_REVIEW_MARKER,
  markComment,
  commentedLineKeys,
  filterAlreadyCommented,
} from '../index.ts';
import type { ExistingComment, InlineComment } from '../index.ts';

describe('markComment', () => {
  it('добавляет скрытый маркер в конец', () => {
    const marked = markComment('текст комментария');
    assert.match(marked, /текст комментария/);
    assert.ok(marked.includes(AI_REVIEW_MARKER));
  });
});

describe('commentedLineKeys', () => {
  it('ключи строк с НАШИМ комментарием; чужие и устаревшие игнорируются', () => {
    const existing: ExistingComment[] = [
      { path: 'a.ts', line: 5, body: markComment('наше замечание') },
      { path: 'a.ts', line: 9, body: 'комментарий человека без маркера' },
      { path: 'b.ts', line: null, body: markComment('устаревший — код изменился') },
      { path: 'c.ts', line: 3, body: markComment('наше на c') },
    ];
    assert.deepEqual([...commentedLineKeys(existing)].sort(), ['a.ts:5', 'c.ts:3']);
  });
});

describe('filterAlreadyCommented', () => {
  it('отсеивает инлайн на уже прокомментированных нами строках', () => {
    const comments: InlineComment[] = [
      { file: 'a.ts', line: 5, body: 'x' }, // уже есть → отсеять
      { file: 'a.ts', line: 6, body: 'y' }, // новая строка → оставить
      { file: 'c.ts', line: 3, body: 'z' }, // уже есть → отсеять
    ];
    const existing = new Set(['a.ts:5', 'c.ts:3']);
    assert.deepEqual(
      filterAlreadyCommented(comments, existing).map(c => `${c.file}:${c.line}`),
      ['a.ts:6'],
    );
  });

  it('пустой набор существующих — всё остаётся', () => {
    const comments: InlineComment[] = [{ file: 'a.ts', line: 1, body: 'x' }];
    assert.deepEqual(filterAlreadyCommented(comments, new Set()), comments);
  });
});
