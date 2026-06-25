import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatTzOffset, currentTimeContext } from '../index.ts';

describe('formatTzOffset', () => {
  it('форматирует смещение со знаком и минутами', () => {
    assert.equal(formatTzOffset(300), '+05:00');
    assert.equal(formatTzOffset(-330), '-05:30');
    assert.equal(formatTzOffset(0), '+00:00');
  });
});

describe('currentTimeContext', () => {
  it('содержит ISO-время в UTC и tzOffsetMinutes текущего пояса', () => {
    const now = new Date('2026-06-25T10:00:00.000Z');
    const context = currentTimeContext(now);
    assert.match(context, /2026-06-25T10:00:00\.000Z/);
    assert.match(context, new RegExp(`tzOffsetMinutes=${-now.getTimezoneOffset()}\\b`));
  });
});
