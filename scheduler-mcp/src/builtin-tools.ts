import type { ToolSet, ToolSpec } from '../../core/src/index.ts';
import { fetchWeather } from './weather.ts';

/** HTTP-клиент для встроенных инструментов агента (шов для тестов). */
export type BuiltinFetch = (
  url: string,
  init?: { method?: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }>;

/** Максимум символов тела, отдаваемых инструментом http_get модели. */
const HTTP_GET_BODY_LIMIT = 2000;

/** Текст ошибки из неизвестного значения. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Набор встроенных инструментов для server-side агента-исполнителя (Фаза 2): получить прогноз
 * погоды по координатам и сделать GET-запрос. Реализует контракт core.ToolSet, поэтому
 * подключается к `Conversation` как обычный источник tool-use.
 */
export class BuiltinToolSet implements ToolSet {
  private readonly fetchFn: BuiltinFetch;

  constructor(fetchFn: BuiltinFetch) {
    this.fetchFn = fetchFn;
  }

  specs(): ToolSpec[] {
    return [
      {
        name: 'get_weather',
        description:
          'Прогноз погоды на сегодня по координатам (Open-Meteo). Возвращает температуру, ' +
          'вероятность осадков и описание. Аргументы: latitude, longitude (числа).',
        parameters: {
          type: 'object',
          properties: {
            latitude: { type: 'number' },
            longitude: { type: 'number' },
          },
          required: ['latitude', 'longitude'],
        },
      },
      {
        name: 'http_get',
        description: 'GET-запрос к URL. Возвращает HTTP-статус и начало тела ответа.',
        parameters: {
          type: 'object',
          properties: { url: { type: 'string' } },
          required: ['url'],
        },
      },
    ];
  }

  async call(name: string, args: Record<string, unknown>): Promise<string> {
    if (name === 'get_weather') {
      return this.getWeather(args);
    }
    if (name === 'http_get') {
      return this.httpGet(args);
    }
    throw new Error(`Неизвестный инструмент: ${name}`);
  }

  /** Прогноз погоды по координатам из аргументов. */
  private async getWeather(args: Record<string, unknown>): Promise<string> {
    const latitude = args.latitude;
    const longitude = args.longitude;
    if (typeof latitude !== 'number' || typeof longitude !== 'number') {
      return 'Нужны числовые latitude и longitude.';
    }
    try {
      const forecast = await fetchWeather(latitude, longitude, this.fetchFn);
      return (
        `Погода сейчас: ${forecast.description}, ${forecast.temperatureC}°C, ` +
        `осадки ${forecast.precipitationMm} мм.`
      );
    } catch (error) {
      return `Не удалось получить погоду: ${errorMessage(error)}`;
    }
  }

  /** GET-запрос к URL с усечённым телом. */
  private async httpGet(args: Record<string, unknown>): Promise<string> {
    const url = args.url;
    if (typeof url !== 'string' || url.trim() === '') {
      return 'Нужен непустой url.';
    }
    try {
      const response = await this.fetchFn(url, { method: 'GET' });
      const body = (await response.text()).slice(0, HTTP_GET_BODY_LIMIT);
      return `HTTP ${response.status}\n${body}`;
    } catch (error) {
      return `Запрос не удался: ${errorMessage(error)}`;
    }
  }
}
