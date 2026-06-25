/** Прогноз погоды на день (из Open-Meteo, без ключа). */
export interface WeatherForecast {
  tempMaxC: number;
  tempMinC: number;
  precipitationProbabilityPercent: number;
  description: string;
}

/** Минимальный HTTP-клиент для запроса погоды (шов для тестов). */
export type WeatherFetch = (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/** Расшифровка кода погоды Open-Meteo (WMO) на русский. */
const WEATHER_CODE_RU: Record<number, string> = {
  0: 'ясно',
  1: 'преимущественно ясно',
  2: 'переменная облачность',
  3: 'пасмурно',
  45: 'туман',
  48: 'изморозь',
  51: 'слабая морось',
  53: 'морось',
  55: 'сильная морось',
  61: 'слабый дождь',
  63: 'дождь',
  65: 'сильный дождь',
  71: 'слабый снег',
  73: 'снег',
  75: 'сильный снег',
  80: 'ливни',
  81: 'ливни',
  82: 'сильные ливни',
  95: 'гроза',
  96: 'гроза с градом',
  99: 'сильная гроза с градом',
};

/** Человекочитаемое описание кода погоды. */
function describeWeatherCode(code: number): string {
  return WEATHER_CODE_RU[code] ?? `код погоды ${code}`;
}

/** Первый числовой элемент массива из произвольного значения или null. */
function firstNumber(value: unknown): number | null {
  if (Array.isArray(value) && typeof value[0] === 'number') {
    return value[0];
  }
  return null;
}

/** Разбирает ответ Open-Meteo в прогноз; бросает при неожиданной структуре. */
export function parseForecast(data: unknown): WeatherForecast {
  const daily = (data as { daily?: Record<string, unknown> } | null)?.daily;
  const tempMaxC = firstNumber(daily?.temperature_2m_max);
  const tempMinC = firstNumber(daily?.temperature_2m_min);
  const precipitation = firstNumber(daily?.precipitation_probability_max);
  const code = firstNumber(daily?.weather_code);
  if (tempMaxC === null || tempMinC === null || precipitation === null || code === null) {
    throw new Error('Неожиданный ответ Open-Meteo (нет дневного прогноза).');
  }
  return {
    tempMaxC,
    tempMinC,
    precipitationProbabilityPercent: precipitation,
    description: describeWeatherCode(code),
  };
}

/** Запрашивает прогноз на день по координатам через Open-Meteo. */
export async function fetchWeather(
  latitude: number,
  longitude: number,
  fetchFn: WeatherFetch,
): Promise<WeatherForecast> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
    '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code' +
    '&timezone=auto&forecast_days=1';
  const response = await fetchFn(url);
  if (!response.ok) {
    throw new Error('Open-Meteo вернул ответ с ошибкой.');
  }
  return parseForecast(await response.json());
}
