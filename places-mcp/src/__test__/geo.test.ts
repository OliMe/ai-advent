import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { haversineMeters, nearestFirst, pick, asString } from '../index.ts';
import type { Place } from '../index.ts';

describe('haversineMeters', () => {
  it('одна и та же точка → 0', () => {
    assert.equal(haversineMeters(55.75, 37.6, 55.75, 37.6), 0);
  });
  it('близкие точки → правдоподобное расстояние (~1.3 км)', () => {
    const meters = haversineMeters(55.75, 37.61, 55.76, 37.62);
    assert.ok(meters > 1000 && meters < 1500, `получили ${meters}`);
  });
});

describe('nearestFirst', () => {
  it('сортирует по расстоянию и обрезает до limit', () => {
    const make = (d: number): Place => ({
      name: String(d),
      address: '',
      latitude: 0,
      longitude: 0,
      distanceMeters: d,
    });
    const sorted = nearestFirst([make(300), make(100), make(200)], 2);
    assert.deepEqual(
      sorted.map(p => p.distanceMeters),
      [100, 200],
    );
  });
});

describe('pick', () => {
  it('достаёт поле объекта; не-объект → undefined', () => {
    assert.equal(pick({ a: 1 }, 'a'), 1);
    assert.equal(pick(null, 'a'), undefined);
    assert.equal(pick('строка', 'a'), undefined);
  });
});

describe('asString', () => {
  it('непустая строка проходит; пустая/не строка → undefined', () => {
    assert.equal(asString('x'), 'x');
    assert.equal(asString('   '), undefined);
    assert.equal(asString(42), undefined);
  });
});
