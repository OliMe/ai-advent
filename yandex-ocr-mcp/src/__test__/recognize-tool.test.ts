import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runRecognizeText } from '../index.ts';
import type { FetchLike, HttpResponse, ImageReaders, OcrConfig } from '../index.ts';

const config: OcrConfig = {
  authorization: 'Api-Key k',
  endpoint: 'https://example.test/ocr',
  timeoutMs: 5000,
  model: 'page',
  languageCodes: ['*'],
};

const readers: ImageReaders = {
  readFile: async () => Buffer.from('файл'),
  fetchUrl: async () => ({ buffer: Buffer.from('сеть'), contentType: undefined }),
};

/** Фейковый fetch: всегда успех с заданным текстом; ловит тело запроса. */
function fetchOk(text: string, capture?: (body: Record<string, unknown>) => void): FetchLike {
  return async (_url, init): Promise<HttpResponse> => {
    capture?.(JSON.parse(init.body) as Record<string, unknown>);
    return {
      ok: true,
      status: 200,
      json: async () => ({ result: { textAnnotation: { fullText: text } } }),
    };
  };
}

describe('runRecognizeText', () => {
  it('распознаёт изображение и возвращает текст MCP-блоком', async () => {
    const result = await runRecognizeText(
      { config, readers, fetchFn: fetchOk('распознано') },
      {
        path: 'scan.png',
      },
    );
    assert.deepEqual(result, { content: [{ type: 'text', text: 'распознано' }] });
  });

  it('берёт модель и языки из аргументов, если заданы', async () => {
    let body: Record<string, unknown> | undefined;
    await runRecognizeText(
      { config, readers, fetchFn: fetchOk('x', captured => (body = captured)) },
      {
        base64: 'QUJD',
        model: 'handwritten',
        languageCodes: ['ru'],
      },
    );
    assert.equal(body?.model, 'handwritten');
    assert.deepEqual(body?.languageCodes, ['ru']);
  });

  it('иначе берёт модель и языки из конфигурации', async () => {
    let body: Record<string, unknown> | undefined;
    await runRecognizeText(
      { config, readers, fetchFn: fetchOk('x', captured => (body = captured)) },
      {
        base64: 'QUJD',
      },
    );
    assert.equal(body?.model, 'page'); // дефолт из конфигурации
    assert.deepEqual(body?.languageCodes, ['*']);
  });
});
