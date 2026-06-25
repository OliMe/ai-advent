import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseForecast, fetchWeather } from '../index.ts';
import type { WeatherFetch } from '../index.ts';

const dailyData = (overrides: Record<string, unknown> = {}) => ({
  daily: {
    temperature_2m_max: [15],
    temperature_2m_min: [8],
    precipitation_probability_max: [70],
    weather_code: [2],
    ...overrides,
  },
});

describe('parseForecast', () => {
  it('разбирает дневной прогноз и расшифровывает код', () => {
    const forecast = parseForecast(dailyData());
    assert.deepEqual(forecast, {
      tempMaxC: 15,
      tempMinC: 8,
      precipitationProbabilityPercent: 70,
      description: 'переменная облачность',
    });
  });

  it('незнакомый код погоды → текст «код погоды N»', () => {
    assert.equal(parseForecast(dailyData({ weather_code: [999] })).description, 'код погоды 999');
  });

  it('нет daily → ошибка', () => {
    assert.throws(() => parseForecast({}), /Неожиданный ответ Open-Meteo/);
  });

  it('массив не из чисел или пустой → ошибка', () => {
    assert.throws(() => parseForecast(dailyData({ temperature_2m_max: 'x' })), /Неожиданный ответ/);
    assert.throws(() => parseForecast(dailyData({ temperature_2m_min: [] })), /Неожиданный ответ/);
  });
});

describe('fetchWeather', () => {
  it('ok → прогноз', async () => {
    const fetchFn: WeatherFetch = async () => ({ ok: true, json: async () => dailyData() });
    const forecast = await fetchWeather(56.85, 60.61, fetchFn);
    assert.equal(forecast.tempMaxC, 15);
  });

  it('не-ok → ошибка', async () => {
    const fetchFn: WeatherFetch = async () => ({ ok: false, json: async () => ({}) });
    await assert.rejects(() => fetchWeather(1, 2, fetchFn), /ответ с ошибкой/);
  });
});
