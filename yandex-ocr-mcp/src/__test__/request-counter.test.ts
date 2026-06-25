import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RequestCounter } from '../index.ts';

describe('RequestCounter', () => {
  it('стартует с нуля и хранит момент запуска', () => {
    const counter = new RequestCounter('2026-06-25T00:00:00.000Z');
    assert.deepEqual(counter.snapshot(), { requests: 0, since: '2026-06-25T00:00:00.000Z' });
  });

  it('считает вызовы', () => {
    const counter = new RequestCounter('2026-06-25T00:00:00.000Z');
    counter.increment();
    counter.increment();
    assert.equal(counter.snapshot().requests, 2);
  });
});
