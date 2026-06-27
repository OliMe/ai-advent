import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleFindPlaces } from '../index.ts';
import type { FetchLike, PlacesConfig, ToolDeps } from '../index.ts';

const config: PlacesConfig = {
  apiKey: 'KEY',
  endpoint: 'https://search-maps.yandex.ru/v1/',
  lang: 'ru_RU',
  defaultRadius: 1500,
  defaultResults: 5,
  timeoutMs: 1000,
};

const oneResult = {
  features: [
    {
      geometry: { coordinates: [37.605, 55.751] },
      properties: { CompanyMetaData: { name: 'Аптека', address: 'ул. Тверская, 1' } },
    },
  ],
};

/** deps с фейковым fetch; собирает увиденные URL. */
function makeDeps(fetchFn: FetchLike): { deps: ToolDeps; urls: string[] } {
  const urls: string[] = [];
  const wrapped: FetchLike = async (url, init) => {
    urls.push(url);
    return fetchFn(url, init);
  };
  return { deps: { config, fetchFn: wrapped }, urls };
}

const okFetch: FetchLike = async () => ({ ok: true, status: 200, json: async () => oneResult });

describe('handleFindPlaces', () => {
  it('находит и форматирует места', async () => {
    const { deps } = makeDeps(okFetch);
    const out = await handleFindPlaces(deps, {
      text: 'аптека',
      latitude: 55.75,
      longitude: 37.605,
    });
    assert.match(out, /📍 Аптека/);
    assert.match(out, /ул\. Тверская, 1/);
  });

  it('радиус и лимит по умолчанию vs заданные (results в URL)', async () => {
    const def = makeDeps(okFetch);
    await handleFindPlaces(def.deps, { text: 'кафе', latitude: 55.75, longitude: 37.6 });
    assert.match(def.urls[0], /results=5/); // дефолт

    const custom = makeDeps(okFetch);
    await handleFindPlaces(custom.deps, {
      text: 'кафе',
      latitude: 55.75,
      longitude: 37.6,
      radius: 500,
      limit: 3,
    });
    assert.match(custom.urls[0], /results=3/); // заданный
  });

  it('пустой text → подсказка', async () => {
    const { deps } = makeDeps(okFetch);
    assert.match(
      await handleFindPlaces(deps, { latitude: 55.75, longitude: 37.6 }),
      /непустой text/,
    );
  });

  it('нет latitude или нет longitude → подсказка про координаты', async () => {
    const { deps } = makeDeps(okFetch);
    assert.match(
      await handleFindPlaces(deps, { text: 'аптека', longitude: 37.6 }),
      /latitude и longitude/,
    );
    assert.match(
      await handleFindPlaces(deps, { text: 'аптека', latitude: 55.75 }),
      /latitude и longitude/,
    );
  });

  it('ошибка HTTP → текст ошибки (Error)', async () => {
    const { deps } = makeDeps(async () => ({ ok: false, status: 403, json: async () => ({}) }));
    assert.match(
      await handleFindPlaces(deps, { text: 'аптека', latitude: 55.75, longitude: 37.6 }),
      /HTTP 403/,
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
