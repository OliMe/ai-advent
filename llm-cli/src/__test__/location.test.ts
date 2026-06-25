import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLocation, LocationToolSet } from '../index.ts';
import type { LocationFetch } from '../index.ts';

const okFetch =
  (json: unknown): LocationFetch =>
  async () => ({ ok: true, json: async () => json });

describe('resolveLocation', () => {
  it('возвращает город и координаты', async () => {
    const location = await resolveLocation(
      okFetch({ city: 'Екатеринбург', latitude: 56.85, longitude: 60.61 }),
    );
    assert.deepEqual(location, { city: 'Екатеринбург', latitude: 56.85, longitude: 60.61 });
  });

  it('город отсутствует/не строка → «неизвестно»', async () => {
    const location = await resolveLocation(okFetch({ latitude: 1, longitude: 2 }));
    assert.equal(location.city, 'неизвестно');
  });

  it('не-ok ответ → ошибка', async () => {
    const failing: LocationFetch = async () => ({ ok: false, json: async () => ({}) });
    await assert.rejects(() => resolveLocation(failing), /геолокации недоступен/);
  });

  it('нет координат → ошибка', async () => {
    await assert.rejects(() => resolveLocation(okFetch({ city: 'X' })), /неожиданный ответ/);
  });
});

describe('LocationToolSet', () => {
  it('specs содержит get_my_location', () => {
    assert.deepEqual(
      new LocationToolSet(okFetch({})).specs().map(spec => spec.name),
      ['get_my_location'],
    );
  });

  it('call get_my_location → текст с городом и координатами', async () => {
    const tools = new LocationToolSet(
      okFetch({ city: 'Москва', latitude: 55.75, longitude: 37.62 }),
    );
    const result = await tools.call('get_my_location', {});
    assert.match(result, /Местоположение: Москва, latitude=55\.75, longitude=37\.62/);
  });

  it('неизвестный инструмент → бросает', async () => {
    await assert.rejects(
      () => new LocationToolSet(okFetch({})).call('нет', {}),
      /Неизвестный инструмент/,
    );
  });
});
