/** Конфигурация поиска организаций (Yandex Search API for organizations / Geosearch). */
export interface PlacesConfig {
  /** API-ключ Yandex Search API (поиск по организациям). */
  apiKey: string;
  /** Базовый URL поиска. */
  endpoint: string;
  /** Язык ответа (например, ru_RU). */
  lang: string;
  /** Радиус поиска по умолчанию, метры. */
  defaultRadius: number;
  /** Сколько результатов отдавать по умолчанию. */
  defaultResults: number;
  /** Таймаут запроса, мс. */
  timeoutMs: number;
}

const DEFAULT_ENDPOINT = 'https://search-maps.yandex.ru/v1/';
const DEFAULT_LANG = 'ru_RU';
const DEFAULT_RADIUS_METERS = 1500;
const DEFAULT_RESULTS = 5;
const DEFAULT_TIMEOUT_MS = 15_000;

/** Целое не меньше 1 из env или значение по умолчанию. */
function parsePositiveInteger(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 ? value : fallback;
}

/** Собирает конфигурацию поиска мест из окружения; без ключа — ошибка (сервер не запускаем). */
export function loadPlacesConfig(env: NodeJS.ProcessEnv): PlacesConfig {
  const apiKey = env.YANDEX_PLACES_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      'Не задан YANDEX_PLACES_API_KEY (ключ Yandex Search API for organizations) — укажите в .env.',
    );
  }
  return {
    apiKey,
    endpoint: env.YANDEX_PLACES_ENDPOINT?.trim() || DEFAULT_ENDPOINT,
    lang: env.YANDEX_PLACES_LANG?.trim() || DEFAULT_LANG,
    defaultRadius: parsePositiveInteger(env.YANDEX_PLACES_RADIUS_M, DEFAULT_RADIUS_METERS),
    defaultResults: parsePositiveInteger(env.YANDEX_PLACES_RESULTS, DEFAULT_RESULTS),
    timeoutMs: parsePositiveInteger(env.YANDEX_PLACES_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  };
}
