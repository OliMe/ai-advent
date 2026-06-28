import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createProvider } from '../index.ts';
import type { FetchLike, PlacesConfig } from '../index.ts';

const base: PlacesConfig = {
  provider: 'osm',
  apiKey: 'KEY',
  yandexEndpoint: 'https://search-maps.yandex.ru/v1/',
  overpassEndpoint: 'https://overpass-api.de/api/interpreter',
  userAgent: 'test',
  lang: 'ru_RU',
  defaultRadius: 1500,
  defaultResults: 5,
  timeoutMs: 1000,
};

describe('createProvider', () => {
  it('osm → бьёт в Overpass (POST)', async () => {
    const seen: string[] = [];
    const fetchFn: FetchLike = async url => {
      seen.push(url);
      return { ok: true, status: 200, json: async () => ({ elements: [] }) };
    };
    const provider = createProvider({ ...base, provider: 'osm' }, fetchFn);
    await provider.findPlaces({
      text: 'аптека',
      latitude: 55.75,
      longitude: 37.6,
      radius: 1000,
      limit: 5,
    });
    assert.equal(seen[0], 'https://overpass-api.de/api/interpreter');
  });

  it('yandex → бьёт в Yandex Search API', async () => {
    const seen: string[] = [];
    const fetchFn: FetchLike = async url => {
      seen.push(url);
      return { ok: true, status: 200, json: async () => ({ features: [] }) };
    };
    const provider = createProvider({ ...base, provider: 'yandex' }, fetchFn);
    await provider.findPlaces({
      text: 'аптека',
      latitude: 55.75,
      longitude: 37.6,
      radius: 1000,
      limit: 5,
    });
    assert.match(seen[0], /search-maps\.yandex\.ru/);
  });
});
