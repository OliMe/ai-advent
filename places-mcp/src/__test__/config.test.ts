import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadPlacesConfig } from '../index.ts';

const env = (values: Record<string, string | undefined>): NodeJS.ProcessEnv =>
  values as NodeJS.ProcessEnv;

describe('loadPlacesConfig', () => {
  it('по умолчанию провайдер osm, ключ не требуется, дефолты', () => {
    const config = loadPlacesConfig(env({}));
    assert.equal(config.provider, 'osm');
    assert.equal(config.apiKey, '');
    assert.equal(config.overpassEndpoint, 'https://overpass-api.de/api/interpreter');
    assert.equal(config.yandexEndpoint, 'https://search-maps.yandex.ru/v1/');
    assert.match(config.userAgent, /places-mcp/);
    assert.equal(config.lang, 'ru_RU');
    assert.equal(config.defaultRadius, 1500);
    assert.equal(config.defaultResults, 5);
    assert.equal(config.timeoutMs, 15_000);
  });

  it('provider=yandex с ключом → провайдер yandex, ключ обрезан', () => {
    const config = loadPlacesConfig(
      env({ PLACES_PROVIDER: 'Yandex', YANDEX_PLACES_API_KEY: ' k ' }),
    );
    assert.equal(config.provider, 'yandex');
    assert.equal(config.apiKey, 'k');
  });

  it('provider=yandex без ключа → ошибка', () => {
    assert.throws(
      () => loadPlacesConfig(env({ PLACES_PROVIDER: 'yandex' })),
      /YANDEX_PLACES_API_KEY/,
    );
  });

  it('переопределение эндпоинтов/UA/чисел из окружения', () => {
    const config = loadPlacesConfig(
      env({
        OVERPASS_ENDPOINT: 'https://overpass.example',
        YANDEX_PLACES_ENDPOINT: 'https://yamaps.example/v1/',
        PLACES_USER_AGENT: 'мой-агент',
        YANDEX_PLACES_LANG: 'en_US',
        YANDEX_PLACES_RADIUS_M: '3000',
        YANDEX_PLACES_RESULTS: '10',
        YANDEX_PLACES_TIMEOUT_MS: '5000',
      }),
    );
    assert.deepEqual(
      [
        config.overpassEndpoint,
        config.yandexEndpoint,
        config.userAgent,
        config.lang,
        config.defaultRadius,
        config.defaultResults,
        config.timeoutMs,
      ],
      [
        'https://overpass.example',
        'https://yamaps.example/v1/',
        'мой-агент',
        'en_US',
        3000,
        10,
        5000,
      ],
    );
  });

  it('некорректные числа → дефолты', () => {
    const config = loadPlacesConfig(
      env({ YANDEX_PLACES_RADIUS_M: 'abc', YANDEX_PLACES_RESULTS: '0' }),
    );
    assert.equal(config.defaultRadius, 1500);
    assert.equal(config.defaultResults, 5);
  });
});
