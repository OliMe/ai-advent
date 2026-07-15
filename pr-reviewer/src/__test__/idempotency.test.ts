import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AI_REVIEW_MARKER, markComment, hasAiMarker, ownCommentIds } from '../index.ts';
import type { ApiComment } from '../index.ts';

describe('markComment / hasAiMarker', () => {
  it('маркер добавляется в конец и распознаётся', () => {
    const marked = markComment('текст комментария');
    assert.match(marked, /текст комментария/);
    assert.ok(marked.includes(AI_REVIEW_MARKER));
    assert.equal(hasAiMarker(marked), true);
    assert.equal(hasAiMarker('чужой комментарий'), false);
  });
});

describe('ownCommentIds', () => {
  it('id только НАШИХ комментариев (по маркеру); чужие не трогаем', () => {
    const comments: ApiComment[] = [
      { id: 1, body: markComment('наше замечание') },
      { id: 2, body: 'комментарий человека без маркера' },
      { id: 3, body: markComment('наше на c') },
    ];
    assert.deepEqual(ownCommentIds(comments), [1, 3]);
  });

  it('нет наших комментариев — пустой список', () => {
    assert.deepEqual(ownCommentIds([{ id: 9, body: 'чужое' }]), []);
  });
});
