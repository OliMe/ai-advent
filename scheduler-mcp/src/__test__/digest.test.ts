import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatPromisesDigest } from '../index.ts';
import type { Task } from '../index.ts';

const task = (overrides: Partial<Task>): Task => ({
  id: 'id',
  title: 'задача',
  kind: 'note',
  deliver: 'inbox',
  notify: true,
  schedule: { type: 'daily', at: '09:00', tzOffsetMinutes: 300 },
  status: 'active',
  createdAt: '2026-06-25T00:00:00.000Z',
  nextFireAt: '2026-06-26T04:00:00.000Z',
  ...overrides,
});

describe('formatPromisesDigest', () => {
  it('нет активных note → бодрая заглушка', () => {
    assert.match(formatPromisesDigest([]), /Незакрытых обещаний нет/);
  });

  it('перечисляет активные напоминания, прочее не включает', () => {
    const digest = formatPromisesDigest([
      task({ id: 'a', text: 'позвонить Пете' }),
      task({ id: 'b', text: 'отправить отчёт', nextFireAt: '2026-06-27T04:00:00.000Z' }),
      task({ id: 'c', kind: 'http_check', text: undefined }), // не note — пропустить
      task({ id: 'd', status: 'paused', text: 'на паузе' }), // не active — пропустить
    ]);
    assert.match(digest, /Незакрытые обещания \(2\)/);
    assert.match(digest, /• позвонить Пете — ежедневно в 09:00/);
    assert.match(digest, /• отправить отчёт/);
    assert.doesNotMatch(digest, /на паузе/);
  });

  it('без text использует заголовок', () => {
    assert.match(
      formatPromisesDigest([task({ text: undefined, title: 'Без текста' })]),
      /• Без текста/,
    );
  });
});
