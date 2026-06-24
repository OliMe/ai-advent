import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadOcrConfig } from '../index.ts';

const env = (values: Record<string, string | undefined>): NodeJS.ProcessEnv =>
  values as NodeJS.ProcessEnv;

describe('loadOcrConfig', () => {
  it('API-ключ приоритетнее IAM-токена', () => {
    const config = loadOcrConfig(env({ YANDEX_OCR_API_KEY: 'k', YANDEX_IAM_TOKEN: 't' }));
    assert.equal(config.authorization, 'Api-Key k');
  });

  it('IAM-токен, если API-ключ не задан', () => {
    const config = loadOcrConfig(env({ YANDEX_IAM_TOKEN: 't' }));
    assert.equal(config.authorization, 'Bearer t');
  });

  it('бросает, если креденшелы не заданы', () => {
    assert.throws(() => loadOcrConfig(env({})), /YANDEX_OCR_API_KEY|YANDEX_IAM_TOKEN/);
  });

  it('значения по умолчанию', () => {
    const config = loadOcrConfig(env({ YANDEX_OCR_API_KEY: 'k' }));
    assert.match(config.endpoint, /ocr\.api\.cloud\.yandex\.net/);
    assert.equal(config.timeoutMs, 60_000);
    assert.equal(config.model, 'page');
    assert.deepEqual(config.languageCodes, ['*']);
    assert.equal('folderId' in config, false);
  });

  it('переопределение всех параметров и каталог', () => {
    const config = loadOcrConfig(
      env({
        YANDEX_OCR_API_KEY: 'k',
        YANDEX_FOLDER_ID: 'fld',
        YANDEX_OCR_ENDPOINT: 'https://example.test/ocr',
        YANDEX_OCR_TIMEOUT_MS: '15000',
        YANDEX_OCR_MODEL: 'handwritten',
        YANDEX_OCR_LANGUAGES: 'ru, en',
      }),
    );
    assert.equal(config.folderId, 'fld');
    assert.equal(config.endpoint, 'https://example.test/ocr');
    assert.equal(config.timeoutMs, 15000);
    assert.equal(config.model, 'handwritten');
    assert.deepEqual(config.languageCodes, ['ru', 'en']);
  });

  it('некорректный таймаут откатывается к значению по умолчанию', () => {
    const config = loadOcrConfig(env({ YANDEX_OCR_API_KEY: 'k', YANDEX_OCR_TIMEOUT_MS: 'нет' }));
    assert.equal(config.timeoutMs, 60_000);
  });
});
