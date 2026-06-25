import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseForecast, fetchWeather } from '../index.ts';
import type { WeatherFetch } from '../index.ts';

describe('parseForecast (wttr.in компактный формат)', () => {
  it('разбирает описание, температуру и осадки', () => {
    assert.deepEqual(parseForecast('Переменная облачность|+19°C|0.0mm'), {
      temperatureC: 19,
      precipitationMm: 0,
      description: 'Переменная облачность',
    });
  });

  it('отрицательная температура и осадки', () => {
    const forecast = parseForecast('Снег|-5°C|1.2mm');
    assert.equal(forecast.temperatureC, -5);
    assert.equal(forecast.precipitationMm, 1.2);
  });

  it('нет числа в осадках → 0', () => {
    assert.equal(parseForecast('Ясно|+10°C|—').precipitationMm, 0);
  });

  it('меньше трёх полей → ошибка', () => {
    assert.throws(() => parseForecast('что-то|+10°C'), /Неожиданный ответ wttr\.in\./);
  });

  it('нет температуры → ошибка', () => {
    assert.throws(() => parseForecast('Ясно|нет данных|0mm'), /нет температуры/);
  });
});

describe('fetchWeather', () => {
  it('ok → прогноз', async () => {
    const fetchFn: WeatherFetch = async () => ({
      ok: true,
      text: async () => 'Дождь|+12°C|3.0mm',
    });
    const forecast = await fetchWeather(56.85, 60.61, fetchFn);
    assert.equal(forecast.temperatureC, 12);
    assert.equal(forecast.description, 'Дождь');
  });

  it('не-ok → ошибка', async () => {
    const fetchFn: WeatherFetch = async () => ({ ok: false, text: async () => '' });
    await assert.rejects(() => fetchWeather(1, 2, fetchFn), /ответ с ошибкой/);
  });
});
