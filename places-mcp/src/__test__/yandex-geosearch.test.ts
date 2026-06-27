import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  haversineMeters,
  parseGeosearchResponse,
  findPlaces,
  type FetchLike,
  type PlacesConfig,
} from '../index.ts';

const config: PlacesConfig = {
  apiKey: 'KEY',
  endpoint: 'https://search-maps.yandex.ru/v1/',
  lang: 'ru_RU',
  defaultRadius: 1500,
  defaultResults: 5,
  timeoutMs: 1000,
};

/** Полный ответ Geosearch: первая дальше, вторая ближе (проверяем сортировку). */
const sampleResponse = {
  type: 'FeatureCollection',
  features: [
    {
      geometry: { coordinates: [37.62, 55.77] }, // дальше от центра
      properties: { name: 'Аптека дальняя', description: 'ул. Дальняя, 9' },
    },
    {
      geometry: { coordinates: [37.605, 55.751] }, // ближе к центру
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
    { geometry: { coordinates: [1] } }, // битые координаты — пропускается
  ],
};

describe('haversineMeters', () => {
  it('одна и та же точка → 0', () => {
    assert.equal(haversineMeters(55.75, 37.6, 55.75, 37.6), 0);
  });
  it('близкие точки → правдоподобное расстояние', () => {
    const meters = haversineMeters(55.75, 37.61, 55.76, 37.62);
    assert.ok(meters > 1000 && meters < 1500, `ожидали ~1.3км, получили ${meters}`);
  });
});

describe('parseGeosearchResponse', () => {
  it('features не массив → пусто', () => {
    assert.deepEqual(parseGeosearchResponse({}, 55.75, 37.6, 5), []);
  });

  it('парсит, считает расстояние, сортирует по близости, тянет meta', () => {
    const places = parseGeosearchResponse(sampleResponse, 55.75, 37.605, 5);
    assert.equal(places.length, 2); // битая запись отброшена
    assert.equal(places[0].name, 'Аптека 36.6'); // ближайшая первой, имя из CompanyMetaData
    assert.equal(places[0].address, 'Москва, ул. Тверская, 1');
    assert.equal(places[0].phone, '+7 495 000-00-00');
    assert.equal(places[0].hours, 'круглосуточно');
    assert.equal(places[0].url, 'https://apteka.example');
    assert.ok(places[0].distanceMeters < places[1].distanceMeters);
    // вторая — без meta: имя/адрес из properties, без телефона/часов/url
    assert.equal(places[1].name, 'Аптека дальняя');
    assert.equal(places[1].address, 'ул. Дальняя, 9');
    assert.equal(places[1].phone, undefined);
    assert.equal(places[1].hours, undefined);
    assert.equal(places[1].url, undefined);
  });

  it('лимит обрезает список', () => {
    assert.equal(parseGeosearchResponse(sampleResponse, 55.75, 37.605, 1).length, 1);
  });

  it('нет имени нигде → «без названия», адрес пустой', () => {
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

describe('findPlaces', () => {
  it('строит URL (apikey/text/ll/spn/type/results) и парсит ответ', async () => {
    const seen: string[] = [];
    const fetchFn: FetchLike = async url => {
      seen.push(url);
      return { ok: true, status: 200, json: async () => sampleResponse };
    };
    const places = await findPlaces(fetchFn, config, {
      text: 'аптека',
      latitude: 55.75,
      longitude: 37.605,
      radius: 1500,
      limit: 5,
    });
    assert.equal(places.length, 2);
    assert.match(seen[0], /search-maps\.yandex\.ru\/v1\//);
    assert.match(seen[0], /apikey=KEY/);
    assert.match(seen[0], /text=%D0%B0%D0%BF%D1%82%D0%B5%D0%BA%D0%B0/); // «аптека» urlencoded
    assert.match(seen[0], /ll=37\.605%2C55\.75/);
    assert.match(seen[0], /type=biz/);
    assert.match(seen[0], /results=5/);
    assert.match(seen[0], /spn=/);
  });

  it('ошибка HTTP → исключение со статусом', async () => {
    const fetchFn: FetchLike = async () => ({ ok: false, status: 403, json: async () => ({}) });
    await assert.rejects(
      () =>
        findPlaces(fetchFn, config, {
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
