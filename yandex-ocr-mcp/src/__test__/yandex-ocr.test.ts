import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { recognizeText, parseOcrResponse } from '../index.ts';
import type { FetchLike, HttpResponse, OcrConfig, OcrRequest } from '../index.ts';

const config = (folderId?: string): OcrConfig => ({
  authorization: 'Api-Key k',
  endpoint: 'https://example.test/ocr',
  timeoutMs: 5000,
  model: 'page',
  languageCodes: ['*'],
  ...(folderId ? { folderId } : {}),
});

const request: OcrRequest = {
  content: 'QUJD',
  mimeType: 'image/png',
  languageCodes: ['ru'],
  model: 'page',
};

/** Фейковый fetch: отдаёт заданный ответ и (опц.) ловит переданный init. */
function fakeFetch(
  reply: { ok: boolean; status: number; json: unknown },
  capture?: (init: { headers: Record<string, string>; body: string }) => void,
): FetchLike {
  return async (_url, init): Promise<HttpResponse> => {
    capture?.(init);
    return { ok: reply.ok, status: reply.status, json: async () => reply.json };
  };
}

describe('parseOcrResponse', () => {
  it('извлекает fullText (в т.ч. пустой)', () => {
    const json = { result: { textAnnotation: { fullText: 'привет' } } };
    assert.deepEqual(parseOcrResponse(json), { fullText: 'привет' });
    assert.deepEqual(parseOcrResponse({ result: { textAnnotation: { fullText: '' } } }), {
      fullText: '',
    });
  });

  it('бросает, если текста нет', () => {
    assert.throws(() => parseOcrResponse({ result: {} }), /без распознанного текста/);
  });
});

describe('recognizeText', () => {
  it('успех: шлёт заголовки/тело и возвращает текст', async () => {
    let captured: { headers: Record<string, string>; body: string } | undefined;
    const result = await recognizeText(
      fakeFetch(
        { ok: true, status: 200, json: { result: { textAnnotation: { fullText: 'строка' } } } },
        init => (captured = init),
      ),
      config('fld'),
      request,
    );
    assert.deepEqual(result, { fullText: 'строка' });
    assert.equal(captured?.headers.Authorization, 'Api-Key k');
    assert.equal(captured?.headers['x-folder-id'], 'fld');
    assert.deepEqual(JSON.parse(captured?.body ?? '{}'), {
      mimeType: 'image/png',
      languageCodes: ['ru'],
      model: 'page',
      content: 'QUJD',
    });
  });

  it('без folderId заголовок x-folder-id отсутствует', async () => {
    let captured: { headers: Record<string, string>; body: string } | undefined;
    await recognizeText(
      fakeFetch(
        { ok: true, status: 200, json: { result: { textAnnotation: { fullText: 'x' } } } },
        init => (captured = init),
      ),
      config(),
      request,
    );
    assert.equal('x-folder-id' in (captured?.headers ?? {}), false);
  });

  it('ошибка: сообщение верхнего уровня', async () => {
    await assert.rejects(
      () =>
        recognizeText(
          fakeFetch({ ok: false, status: 403, json: { message: 'forbidden' } }),
          config(),
          request,
        ),
      /Yandex OCR 403: forbidden/,
    );
  });

  it('ошибка: вложенное error.message', async () => {
    await assert.rejects(
      () =>
        recognizeText(
          fakeFetch({ ok: false, status: 400, json: { error: { message: 'bad' } } }),
          config(),
          request,
        ),
      /Yandex OCR 400: bad/,
    );
  });

  it('ошибка: тело без сообщения → «неизвестная ошибка»', async () => {
    await assert.rejects(
      () => recognizeText(fakeFetch({ ok: false, status: 500, json: {} }), config(), request),
      /неизвестная ошибка/,
    );
  });
});
