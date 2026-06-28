import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveFilter,
  buildOverpassQuery,
  parseOverpassResponse,
  osmFindPlaces,
  createOsmProvider,
} from '../index.ts';
import type { FetchLike, PlacesConfig } from '../index.ts';

const config: PlacesConfig = {
  provider: 'osm',
  apiKey: '',
  yandexEndpoint: 'https://search-maps.yandex.ru/v1/',
  overpassEndpoint: 'https://overpass-api.de/api/interpreter',
  userAgent: 'ai-advent-test',
  lang: 'ru_RU',
  defaultRadius: 1500,
  defaultResults: 5,
  timeoutMs: 1000,
};

describe('resolveFilter', () => {
  it('известная категория (подстрока) → OSM-тег', () => {
    assert.equal(resolveFilter('ближайшая аптека'), '[amenity=pharmacy]');
    assert.equal(resolveFilter('Банкомат'), '[amenity=atm]');
  });
  it('незнакомый запрос → фолбэк по имени', () => {
    assert.equal(resolveFilter('Пятёрочка'), '[name~"Пятёрочка",i]');
  });
});

describe('buildOverpassQuery', () => {
  it('содержит around с радиусом/координатами, фильтр и out center', () => {
    const query = buildOverpassQuery('[amenity=pharmacy]', 55.75, 37.6, 1000, 20);
    assert.match(query, /\[out:json\]/);
    assert.match(query, /nwr\(around:1000,55\.75,37\.6\)\[amenity=pharmacy\]/);
    assert.match(query, /out center 20;/);
  });
});

const overpassResponse = {
  elements: [
    {
      type: 'node',
      lat: 55.7512,
      lon: 37.6051,
      tags: {
        name: 'Аптека 36.6',
        'addr:street': 'ул. Тверская',
        'addr:housenumber': '1',
        phone: '+7 495 000-00-00',
        opening_hours: '24/7',
      },
    },
    {
      type: 'way',
      center: { lat: 55.77, lon: 37.62 }, // дальше; координаты из center
      tags: { 'addr:street': 'ул. Дальняя', 'contact:phone': '+7 495 111-11-11' }, // без name/house/hours
    },
    { type: 'node', tags: { name: 'без координат' } }, // нет координат — пропуск
  ],
};

describe('parseOverpassResponse', () => {
  it('elements не массив → пусто', () => {
    assert.deepEqual(parseOverpassResponse({}, 55.75, 37.6, 5), []);
  });

  it('node и way(center), адрес/телефон/часы/фолбэки, сортировка', () => {
    const places = parseOverpassResponse(overpassResponse, 55.75, 37.605, 5);
    assert.equal(places.length, 2); // без координат отброшен
    assert.equal(places[0].name, 'Аптека 36.6'); // ближе
    assert.equal(places[0].address, 'ул. Тверская, 1');
    assert.equal(places[0].phone, '+7 495 000-00-00');
    assert.equal(places[0].hours, '24/7');
    // way: имя — фолбэк, адрес без дома, телефон из contact:phone, без часов
    assert.equal(places[1].name, 'без названия');
    assert.equal(places[1].address, 'ул. Дальняя');
    assert.equal(places[1].phone, '+7 495 111-11-11');
    assert.equal(places[1].hours, undefined);
  });

  it('элемент без addr:street → пустой адрес', () => {
    const place = parseOverpassResponse(
      { elements: [{ type: 'node', lat: 55.75, lon: 37.6, tags: { name: 'X' } }] },
      55.75,
      37.6,
      5,
    )[0];
    assert.equal(place.address, '');
  });
});

describe('osmFindPlaces', () => {
  it('POST в Overpass с телом-запросом и User-Agent, парсит ответ', async () => {
    const seen: { url: string; body?: string; headers?: Record<string, string> }[] = [];
    const fetchFn: FetchLike = async (url, init) => {
      seen.push({ url, body: init.body, headers: init.headers });
      return { ok: true, status: 200, json: async () => overpassResponse };
    };
    const provider = createOsmProvider(fetchFn, config);
    const places = await provider.findPlaces({
      text: 'аптека',
      latitude: 55.75,
      longitude: 37.605,
      radius: 1000,
      limit: 5,
    });
    assert.equal(places.length, 2);
    assert.equal(seen[0].url, 'https://overpass-api.de/api/interpreter');
    assert.match(seen[0].body ?? '', /amenity=pharmacy/);
    assert.equal(seen[0].headers?.['User-Agent'], 'ai-advent-test');
  });

  it('ошибка HTTP → исключение со статусом', async () => {
    const fetchFn: FetchLike = async () => ({ ok: false, status: 429, json: async () => ({}) });
    await assert.rejects(
      () =>
        osmFindPlaces(fetchFn, config, {
          text: 'аптека',
          latitude: 55.75,
          longitude: 37.6,
          radius: 1000,
          limit: 5,
        }),
      /HTTP 429/,
    );
  });
});
