import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadVoiceConfig,
  parseSpeechResponse,
  transcribeWithYandex,
  type SpeechFetchLike,
  type VoiceConfig,
} from '../index.ts';

const env = (values: Record<string, string | undefined>): NodeJS.ProcessEnv =>
  values as NodeJS.ProcessEnv;

describe('loadVoiceConfig', () => {
  it('есть api-key и folderId → конфиг с дефолтным языком ru-RU', () => {
    const config = loadVoiceConfig(env({ YANDEX_API_KEY: ' k ', YANDEX_FOLDER_ID: ' f ' }));
    assert.deepEqual(config, { authorization: 'Api-Key k', folderId: 'f', lang: 'ru-RU' });
  });

  it('folderId необязателен — только api-key → конфиг без folderId', () => {
    const config = loadVoiceConfig(env({ YANDEX_API_KEY: 'k' }));
    assert.deepEqual(config, { authorization: 'Api-Key k', lang: 'ru-RU' });
  });

  it('язык можно переопределить через YANDEX_STT_LANG', () => {
    const config = loadVoiceConfig(env({ YANDEX_API_KEY: 'k', YANDEX_STT_LANG: 'en-US' }));
    assert.equal(config?.lang, 'en-US');
  });

  it('нет api-key → null', () => {
    assert.equal(loadVoiceConfig(env({ YANDEX_FOLDER_ID: 'f' })), null);
  });
});

describe('parseSpeechResponse', () => {
  it('берёт result и обрезает пробелы', () => {
    assert.equal(parseSpeechResponse({ result: '  привет мир  ' }), 'привет мир');
  });

  it('нет result (или пустой) → ошибка', () => {
    assert.throws(() => parseSpeechResponse({ result: '   ' }), /пустой результат/);
    assert.throws(() => parseSpeechResponse('не объект'), /пустой результат/);
  });
});

describe('transcribeWithYandex', () => {
  const config: VoiceConfig = { authorization: 'Api-Key k', folderId: 'f1', lang: 'ru-RU' };

  it('успешный ответ → текст; запрос с авторизацией, телом и нужным URL', async () => {
    const seen: {
      url: string;
      init: { method: string; headers: Record<string, string>; body: Uint8Array };
    }[] = [];
    const fetchFn: SpeechFetchLike = async (url, init) => {
      seen.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ result: 'распознано' }) };
    };
    const audio = new Uint8Array([1, 2, 3]);
    assert.equal(await transcribeWithYandex(fetchFn, config, audio, 1000), 'распознано');
    const call = seen[0];
    assert.match(call.url, /stt\.api\.cloud\.yandex\.net/);
    assert.match(call.url, /folderId=f1/);
    assert.match(call.url, /format=oggopus/);
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.headers.Authorization, 'Api-Key k');
    assert.deepEqual(call.init.body, audio);
  });

  it('без folderId в конфиге → в URL нет параметра folderId', async () => {
    const seen: string[] = [];
    const fetchFn: SpeechFetchLike = async url => {
      seen.push(url);
      return { ok: true, status: 200, json: async () => ({ result: 'ок' }) };
    };
    const noFolder: VoiceConfig = { authorization: 'Api-Key k', lang: 'ru-RU' };
    await transcribeWithYandex(fetchFn, noFolder, new Uint8Array(), 1000);
    assert.doesNotMatch(seen[0], /folderId/);
  });

  it('ошибка HTTP → исключение со статусом', async () => {
    const fetchFn: SpeechFetchLike = async () => ({
      ok: false,
      status: 403,
      json: async () => ({}),
    });
    await assert.rejects(
      () => transcribeWithYandex(fetchFn, config, new Uint8Array(), 1000),
      /HTTP 403/,
    );
  });
});
