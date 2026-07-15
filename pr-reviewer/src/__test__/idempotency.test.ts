import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AI_REVIEW_MARKER, markComment, ownCommentIds } from '../index.ts';
import type { ExistingComment } from '../index.ts';

describe('markComment', () => {
  it('добавляет скрытый маркер в конец', () => {
    const marked = markComment('текст комментария');
    assert.match(marked, /текст комментария/);
    assert.ok(marked.includes(AI_REVIEW_MARKER));
  });
});

describe('ownCommentIds', () => {
  it('id только НАШИХ комментариев (по маркеру), включая устаревшие; чужие не трогаем', () => {
    const existing: ExistingComment[] = [
      { id: 1, path: 'a.ts', line: 5, body: markComment('наше замечание') },
      { id: 2, path: 'a.ts', line: 9, body: 'комментарий человека без маркера' },
      { id: 3, path: 'b.ts', line: null, body: markComment('наше устаревшее') }, // тоже снимаем
      { id: 4, path: 'c.ts', line: 3, body: markComment('наше на c') },
    ];
    assert.deepEqual(ownCommentIds(existing), [1, 3, 4]);
  });

  it('нет наших комментариев — пустой список', () => {
    assert.deepEqual(ownCommentIds([{ id: 9, path: 'x.ts', line: 1, body: 'чужое' }]), []);
  });
});
