import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateSchedule, nextFireTime } from '../index.ts';

describe('validateSchedule', () => {
  it('interval: принимает целое ≥1, отвергает прочее', () => {
    assert.doesNotThrow(() => validateSchedule({ type: 'interval', everySeconds: 10 }));
    assert.throws(() => validateSchedule({ type: 'interval', everySeconds: 0 }), /everySeconds/);
    assert.throws(() => validateSchedule({ type: 'interval', everySeconds: 1.5 }), /everySeconds/);
  });

  it('daily: проверяет HH:MM и смещение пояса', () => {
    assert.doesNotThrow(() =>
      validateSchedule({ type: 'daily', at: '08:00', tzOffsetMinutes: 300 }),
    );
    assert.throws(
      () => validateSchedule({ type: 'daily', at: '8:0', tzOffsetMinutes: 0 }),
      /HH:MM/,
    );
    assert.throws(
      () => validateSchedule({ type: 'daily', at: '25:00', tzOffsetMinutes: 0 }),
      /HH:MM/,
    );
    assert.throws(
      () => validateSchedule({ type: 'daily', at: '08:00', tzOffsetMinutes: 1000 }),
      /tzOffsetMinutes/,
    );
    assert.throws(
      () => validateSchedule({ type: 'daily', at: '08:00', tzOffsetMinutes: 1.5 }),
      /tzOffsetMinutes/,
    );
  });

  it('once: проверяет парсимость ISO', () => {
    assert.doesNotThrow(() => validateSchedule({ type: 'once', atIso: '2026-06-25T08:00:00Z' }));
    assert.throws(() => validateSchedule({ type: 'once', atIso: 'не дата' }), /ISO/);
  });
});

describe('nextFireTime', () => {
  it('interval: from + интервал', () => {
    assert.equal(nextFireTime({ type: 'interval', everySeconds: 10 }, 1_000), 11_000);
  });

  it('daily: ближайшее HH:MM сегодня, если ещё не прошло', () => {
    const from = Date.UTC(2026, 0, 1, 0, 0, 0); // 00:00Z = 05:00 по GMT+5
    const next = nextFireTime({ type: 'daily', at: '08:00', tzOffsetMinutes: 300 }, from);
    assert.equal(next, Date.UTC(2026, 0, 1, 3, 0, 0)); // 08:00 локально = 03:00Z
  });

  it('daily: завтра, если время сегодня уже прошло', () => {
    const from = Date.UTC(2026, 0, 1, 6, 0, 0); // 06:00Z = 11:00 по GMT+5
    const next = nextFireTime({ type: 'daily', at: '08:00', tzOffsetMinutes: 300 }, from);
    assert.equal(next, Date.UTC(2026, 0, 2, 3, 0, 0)); // следующий день, 08:00 локально
  });

  it('once: момент из atIso', () => {
    const iso = '2026-06-25T08:00:00.000Z';
    assert.equal(nextFireTime({ type: 'once', atIso: iso }, 0), Date.parse(iso));
  });
});
