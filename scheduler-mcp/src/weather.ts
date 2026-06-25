/** Текущая погода (компактный ответ wttr.in). */
export interface WeatherForecast {
  temperatureC: number;
  precipitationMm: number;
  description: string;
}

/** Минимальный HTTP-клиент для запроса погоды (шов для тестов). */
export type WeatherFetch = (url: string) => Promise<{ ok: boolean; text(): Promise<string> }>;

/** Первое число (возможно дробное/отрицательное) из строки вроде «+19°C» или null. */
function firstNumber(field: string): number | null {
  const match = field.match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

/**
 * Разбирает компактный ответ wttr.in вида «<описание>|<температура>|<осадки>» (формат
 * `%C|%t|%p`). Бросает при неожиданной структуре или отсутствии температуры.
 */
export function parseForecast(text: string): WeatherForecast {
  const parts = text.trim().split('|');
  if (parts.length < 3) {
    throw new Error('Неожиданный ответ wttr.in.');
  }
  const temperatureC = firstNumber(parts[1]);
  if (temperatureC === null) {
    throw new Error('Неожиданный ответ wttr.in (нет температуры).');
  }
  return {
    temperatureC,
    precipitationMm: firstNumber(parts[2]) ?? 0,
    description: parts[0].trim(),
  };
}

/**
 * Запрашивает текущую погоду по координатам через wttr.in (без ключа, компактный формат с
 * русскими описаниями). Лёгкий формат `%C|%t|%p` отвечает быстро (в отличие от тяжёлого j1).
 */
export async function fetchWeather(
  latitude: number,
  longitude: number,
  fetchFn: WeatherFetch,
): Promise<WeatherForecast> {
  const format = encodeURIComponent('%C|%t|%p');
  const response = await fetchFn(
    `https://wttr.in/${latitude},${longitude}?format=${format}&lang=ru`,
  );
  if (!response.ok) {
    throw new Error('wttr.in вернул ответ с ошибкой.');
  }
  return parseForecast(await response.text());
}
