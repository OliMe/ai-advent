import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadPlacesConfig } from '../index.ts';

const env = (values: Record<string, string | undefined>): NodeJS.ProcessEnv =>
  values as NodeJS.ProcessEnv;

describe('loadPlacesConfig', () => {
  it('есть ключ → конфиг с дефолтами', () => {
    const config = loadPlacesConfig(env({ YANDEX_PLACES_API_KEY: ' k ' }));
    assert.equal(config.apiKey, 'k');
    assert.equal(config.endpoint, 'https://search-maps.yandex.ru/v1/');
    assert.equal(config.lang, 'ru_RU');
    assert.equal(config.defaultRadius, 1500);
    assert.equal(config.defaultResults, 5);
    assert.equal(config.timeoutMs, 15_000);
  });

  it('переопределение из окружения (валидные числа)', () => {
    const config = loadPlacesConfig(
      env({
        YANDEX_PLACES_API_KEY: 'k',
        YANDEX_PLACES_ENDPOINT: 'https://example/v1/',
        YANDEX_PLACES_LANG: 'en_US',
        YANDEX_PLACES_RADIUS_M: '3000',
        YANDEX_PLACES_RESULTS: '10',
        YANDEX_PLACES_TIMEOUT_MS: '5000',
      }),
    );
    assert.deepEqual(
      [config.endpoint, config.lang, config.defaultRadius, config.defaultResults, config.timeoutMs],
      ['https://example/v1/', 'en_US', 3000, 10, 5000],
    );
  });

  it('некорректные числа → дефолты', () => {
    const config = loadPlacesConfig(
      env({
        YANDEX_PLACES_API_KEY: 'k',
        YANDEX_PLACES_RADIUS_M: 'abc',
        YANDEX_PLACES_RESULTS: '0',
      }),
    );
    assert.equal(config.defaultRadius, 1500);
    assert.equal(config.defaultResults, 5);
  });

  it('нет ключа → ошибка', () => {
    assert.throws(() => loadPlacesConfig(env({})), /YANDEX_PLACES_API_KEY/);
  });
});
