import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseGeosearchResponse, yandexFindPlaces, createYandexProvider } from '../index.ts';
import type { FetchLike, PlacesConfig } from '../index.ts';

const config: PlacesConfig = {
  provider: 'yandex',
  apiKey: 'KEY',
  yandexEndpoint: 'https://search-maps.yandex.ru/v1/',
  overpassEndpoint: 'https://overpass-api.de/api/interpreter',
  userAgent: 'test',
  lang: 'ru_RU',
  defaultRadius: 1500,
  defaultResults: 5,
  timeoutMs: 1000,
};

const sampleResponse = {
  type: 'FeatureCollection',
  features: [
    {
      geometry: { coordinates: [37.62, 55.77] }, // дальше
      properties: { name: 'Аптека дальняя', description: 'ул. Дальняя, 9' },
    },
    {
      geometry: { coordinates: [37.605, 55.751] }, // ближе
      properties: {
        name: 'игнор',
        description: 'игнор',
        CompanyMetaData: {
          name: 'Аптека 36.6',
          address: 'Москва, ул. Тверская, 1',
          Phones: [{ formatted: '+7 495 000-00-00' }],
          Hours: { text: 'круглосуточно' },
          url: 'https://apteka.example',
        },
      },
    },
    { geometry: { coordinates: [1] } }, // битые координаты — пропуск
  ],
};

describe('parseGeosearchResponse', () => {
  it('features не массив → пусто', () => {
    assert.deepEqual(parseGeosearchResponse({}, 55.75, 37.6, 5), []);
  });

  it('парсит meta, считает расстояние, сортирует, отбрасывает битое', () => {
    const places = parseGeosearchResponse(sampleResponse, 55.75, 37.605, 5);
    assert.equal(places.length, 2);
    assert.equal(places[0].name, 'Аптека 36.6');
    assert.equal(places[0].address, 'Москва, ул. Тверская, 1');
    assert.equal(places[0].phone, '+7 495 000-00-00');
    assert.equal(places[0].hours, 'круглосуточно');
    assert.equal(places[0].url, 'https://apteka.example');
    assert.ok(places[0].distanceMeters < places[1].distanceMeters);
    assert.equal(places[1].name, 'Аптека дальняя');
    assert.equal(places[1].phone, undefined);
  });

  it('лимит обрезает; нет имени → «без названия», адрес пустой', () => {
    assert.equal(parseGeosearchResponse(sampleResponse, 55.75, 37.605, 1).length, 1);
    const place = parseGeosearchResponse(
      { features: [{ geometry: { coordinates: [37.6, 55.75] }, properties: {} }] },
      55.75,
      37.6,
      5,
    )[0];
    assert.equal(place.name, 'без названия');
    assert.equal(place.address, '');
  });
});

describe('yandexFindPlaces', () => {
  it('строит URL (apikey/text/ll/spn/type/results) и парсит', async () => {
    const seen: string[] = [];
    const fetchFn: FetchLike = async url => {
      seen.push(url);
      return { ok: true, status: 200, json: async () => sampleResponse };
    };
    const places = await yandexFindPlaces(fetchFn, config, {
      text: 'аптека',
      latitude: 55.75,
      longitude: 37.605,
      radius: 1500,
      limit: 5,
    });
    assert.equal(places.length, 2);
    assert.match(seen[0], /apikey=KEY/);
    assert.match(seen[0], /ll=37\.605%2C55\.75/);
    assert.match(seen[0], /type=biz/);
    assert.match(seen[0], /results=5/);
  });

  it('ошибка HTTP → исключение; createYandexProvider делегирует', async () => {
    const fetchFn: FetchLike = async () => ({ ok: false, status: 403, json: async () => ({}) });
    const provider = createYandexProvider(fetchFn, config);
    await assert.rejects(
      () =>
        provider.findPlaces({
          text: 'аптека',
          latitude: 55.75,
          longitude: 37.6,
          radius: 1500,
          limit: 5,
        }),
      /HTTP 403/,
    );
  });
});
