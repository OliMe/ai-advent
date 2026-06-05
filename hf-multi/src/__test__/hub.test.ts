import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  modelUrl,
  parseCandidates,
  pickByParams,
  fetchCandidates,
  selectDefaultModels,
  type HfModel,
} from '../hub.ts';

const model = (id: string, params: number): HfModel => ({ id, url: modelUrl(id), params });

describe('modelUrl', () => {
  it('строит ссылку на страницу модели', () => {
    assert.equal(
      modelUrl('Qwen/Qwen2.5-7B-Instruct'),
      'https://huggingface.co/Qwen/Qwen2.5-7B-Instruct',
    );
  });
});

describe('parseCandidates', () => {
  it('оставляет только модели с параметрами и доступным провайдером', () => {
    const raw = [
      {
        id: 'ok/model',
        safetensors: { total: 7_000_000_000 },
        inferenceProviderMapping: [{ provider: 'together' }],
      },
      { id: 'no/params', inferenceProviderMapping: [{ provider: 'together' }] },
      { id: 'no/providers', safetensors: { total: 1000 }, inferenceProviderMapping: [] },
      { safetensors: { total: 1000 }, inferenceProviderMapping: [{ provider: 'x' }] }, // нет id
    ];
    const result = parseCandidates(raw);
    assert.deepEqual(
      result.map(m => m.id),
      ['ok/model'],
    );
    assert.equal(result[0].params, 7_000_000_000);
    assert.equal(result[0].url, 'https://huggingface.co/ok/model');
  });
});

describe('pickByParams', () => {
  it('из четырёх и более берёт крупнейшую, среднюю и мельчайшую', () => {
    const models = [model('a', 10), model('b', 8), model('c', 6), model('d', 4), model('e', 2)];
    assert.deepEqual(
      pickByParams(models).map(m => m.id),
      ['a', 'c', 'e'],
    );
  });

  it('из трёх и менее возвращает все по убыванию', () => {
    const models = [model('s', 2), model('b', 9)];
    assert.deepEqual(
      pickByParams(models).map(m => m.id),
      ['b', 's'],
    );
  });
});

describe('fetchCandidates', () => {
  it('запрашивает и разбирает список', async t => {
    t.mock.method(
      globalThis,
      'fetch',
      async () =>
        new Response(
          JSON.stringify([
            {
              id: 'a/b',
              safetensors: { total: 5000 },
              inferenceProviderMapping: [{ provider: 'p' }],
            },
          ]),
          { status: 200 },
        ),
    );
    const result = await fetchCandidates(10);
    assert.deepEqual(
      result.map(m => m.id),
      ['a/b'],
    );
  });

  it('бросает ошибку при !ok', async t => {
    t.mock.method(
      globalThis,
      'fetch',
      async () => new Response('', { status: 500, statusText: 'Err' }),
    );
    await assert.rejects(fetchCandidates(10), /HF Hub API вернул ошибку 500/);
  });

  it('возвращает пусто, если тело не массив', async t => {
    t.mock.method(
      globalThis,
      'fetch',
      async () => new Response(JSON.stringify({ x: 1 }), { status: 200 }),
    );
    assert.deepEqual(await fetchCandidates(10), []);
  });
});

describe('selectDefaultModels', () => {
  it('подбирает тройку по числу параметров', async t => {
    const raw = [10, 8, 6, 4, 2].map((p, i) => ({
      id: `m${i}`,
      safetensors: { total: p * 1_000_000 },
      inferenceProviderMapping: [{ provider: 'p' }],
    }));
    t.mock.method(
      globalThis,
      'fetch',
      async () => new Response(JSON.stringify(raw), { status: 200 }),
    );
    const result = await selectDefaultModels(50);
    assert.deepEqual(
      result.map(m => m.id),
      ['m0', 'm2', 'm4'],
    );
  });
});
