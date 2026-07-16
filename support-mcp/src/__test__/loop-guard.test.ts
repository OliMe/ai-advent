import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SUPPORT_MARKER, markComment, hasSupportMarker } from '../index.ts';

describe('loop-guard', () => {
  it('markComment дописывает маркер, hasSupportMarker его распознаёт', () => {
    const marked = markComment('Ответ поддержки');
    assert.ok(marked.includes('Ответ поддержки'));
    assert.ok(marked.endsWith(SUPPORT_MARKER));
    assert.equal(hasSupportMarker(marked), true);
  });

  it('чужой комментарий без маркера — не наш', () => {
    assert.equal(hasSupportMarker('Обычный комментарий пользователя'), false);
  });
});
