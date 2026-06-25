import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BuiltinToolSet } from '../index.ts';
import type { BuiltinFetch } from '../index.ts';

/** Фейковый HTTP-клиент с настраиваемым ответом. */
function fakeFetch(
  response: Partial<{ ok: boolean; status: number; body: string; json: unknown }> = {},
  onCall?: (url: string) => void,
): BuiltinFetch {
  return async url => {
    onCall?.(url);
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      text: async () => response.body ?? '',
      json: async () => response.json ?? {},
    };
  };
}

const forecastJson = {
  daily: {
    temperature_2m_max: [15],
    temperature_2m_min: [8],
    precipitation_probability_max: [70],
    weather_code: [2],
  },
};

describe('BuiltinToolSet.specs', () => {
  it('отдаёт get_weather и http_get', () => {
    const names = new BuiltinToolSet(fakeFetch()).specs().map(spec => spec.name);
    assert.deepEqual(names, ['get_weather', 'http_get']);
  });
});

describe('BuiltinToolSet.call — get_weather', () => {
  it('по координатам возвращает сводку погоды', async () => {
    const tools = new BuiltinToolSet(fakeFetch({ json: forecastJson }));
    const result = await tools.call('get_weather', { latitude: 56.85, longitude: 60.61 });
    assert.match(result, /Погода сегодня: переменная облачность, от 8°C до 15°C/);
  });

  it('без числовых координат — подсказка', async () => {
    const tools = new BuiltinToolSet(fakeFetch({ json: forecastJson }));
    assert.match(
      await tools.call('get_weather', { latitude: 'x' }),
      /числовые latitude и longitude/,
    );
    // latitude число, а longitude нет — покрывает правую часть проверки
    assert.match(await tools.call('get_weather', { latitude: 1 }), /числовые latitude и longitude/);
  });

  it('ошибка запроса погоды → текст ошибки', async () => {
    const tools = new BuiltinToolSet(fakeFetch({ ok: false }));
    assert.match(
      await tools.call('get_weather', { latitude: 1, longitude: 2 }),
      /Не удалось получить погоду/,
    );
  });
});

describe('BuiltinToolSet.call — http_get', () => {
  it('возвращает статус и тело', async () => {
    let requested = '';
    const tools = new BuiltinToolSet(
      fakeFetch({ status: 204, body: 'тело' }, url => (requested = url)),
    );
    const result = await tools.call('http_get', { url: 'https://e/' });
    assert.equal(requested, 'https://e/');
    assert.match(result, /HTTP 204\nтело/);
  });

  it('без url или пустой url — подсказка', async () => {
    const tools = new BuiltinToolSet(fakeFetch());
    assert.match(await tools.call('http_get', {}), /Нужен непустой url/);
    assert.match(await tools.call('http_get', { url: '   ' }), /Нужен непустой url/);
  });

  it('ошибка запроса → текст ошибки', async () => {
    const failing: BuiltinFetch = async () => {
      throw new Error('сеть');
    };
    assert.match(
      await new BuiltinToolSet(failing).call('http_get', { url: 'https://e/' }),
      /Запрос не удался: сеть/,
    );
  });

  it('ошибка не-Error → приводится к строке', async () => {
    const failing: BuiltinFetch = async () => {
      throw 'строковый сбой';
    };
    assert.match(
      await new BuiltinToolSet(failing).call('http_get', { url: 'https://e/' }),
      /Запрос не удался: строковый сбой/,
    );
  });
});

describe('BuiltinToolSet.call — прочее', () => {
  it('неизвестный инструмент → бросает', async () => {
    await assert.rejects(
      () => new BuiltinToolSet(fakeFetch()).call('нет', {}),
      /Неизвестный инструмент/,
    );
  });
});
