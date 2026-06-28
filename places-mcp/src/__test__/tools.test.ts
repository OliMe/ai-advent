import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleFindPlaces } from '../index.ts';
import type { FindPlacesQuery, Place, PlaceProvider, PlacesConfig, ToolDeps } from '../index.ts';

const config: PlacesConfig = {
  provider: 'osm',
  apiKey: '',
  yandexEndpoint: 'https://search-maps.yandex.ru/v1/',
  overpassEndpoint: 'https://overpass-api.de/api/interpreter',
  userAgent: 'test',
  lang: 'ru_RU',
  defaultRadius: 1500,
  defaultResults: 5,
  timeoutMs: 1000,
};

const place: Place = {
  name: 'Аптека',
  address: 'ул. Тверская, 1',
  latitude: 55.751,
  longitude: 37.605,
  distanceMeters: 120,
};

/** deps с фейковым провайдером; собирает полученные запросы. */
function makeDeps(findPlaces: (query: FindPlacesQuery) => Promise<Place[]>): {
  deps: ToolDeps;
  queries: FindPlacesQuery[];
} {
  const queries: FindPlacesQuery[] = [];
  const provider: PlaceProvider = {
    findPlaces: query => {
      queries.push(query);
      return findPlaces(query);
    },
  };
  return { deps: { config, provider }, queries };
}

describe('handleFindPlaces', () => {
  it('находит и форматирует места', async () => {
    const { deps } = makeDeps(async () => [place]);
    const out = await handleFindPlaces(deps, { text: 'аптека', latitude: 55.75, longitude: 37.6 });
    assert.match(out, /📍 Аптека/);
    assert.match(out, /ул\. Тверская, 1/);
  });

  it('радиус и лимит: дефолты vs заданные', async () => {
    const def = makeDeps(async () => []);
    await handleFindPlaces(def.deps, { text: 'кафе', latitude: 55.75, longitude: 37.6 });
    assert.equal(def.queries[0].radius, 1500);
    assert.equal(def.queries[0].limit, 5);

    const custom = makeDeps(async () => []);
    await handleFindPlaces(custom.deps, {
      text: 'кафе',
      latitude: 55.75,
      longitude: 37.6,
      radius: 500,
      limit: 3,
    });
    assert.equal(custom.queries[0].radius, 500);
    assert.equal(custom.queries[0].limit, 3);
  });

  it('пустой text → подсказка', async () => {
    const { deps } = makeDeps(async () => []);
    assert.match(
      await handleFindPlaces(deps, { latitude: 55.75, longitude: 37.6 }),
      /непустой text/,
    );
  });

  it('нет latitude или нет longitude → подсказка про координаты', async () => {
    const { deps } = makeDeps(async () => []);
    assert.match(
      await handleFindPlaces(deps, { text: 'аптека', longitude: 37.6 }),
      /latitude и longitude/,
    );
    assert.match(
      await handleFindPlaces(deps, { text: 'аптека', latitude: 55.75 }),
      /latitude и longitude/,
    );
  });

  it('ошибка провайдера (Error) → текст ошибки', async () => {
    const { deps } = makeDeps(async () => {
      throw new Error('Overpass API вернул ошибку HTTP 429.');
    });
    assert.match(
      await handleFindPlaces(deps, { text: 'аптека', latitude: 55.75, longitude: 37.6 }),
      /HTTP 429/,
    );
  });

  it('не-Error исключение приводится к строке', async () => {
    const { deps } = makeDeps(async () => {
      throw 'сетевой сбой';
    });
    assert.equal(
      await handleFindPlaces(deps, { text: 'аптека', latitude: 55.75, longitude: 37.6 }),
      'сетевой сбой',
    );
  });
});
