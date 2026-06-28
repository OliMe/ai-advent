/** Источник данных о местах. */
export type PlacesProvider = 'osm' | 'yandex';

/** Конфигурация поиска организаций (общая для обоих провайдеров). */
export interface PlacesConfig {
  /** Выбранный источник: OpenStreetMap (без ключа) или Yandex Search API (нужен ключ). */
  provider: PlacesProvider;
  /** API-ключ Yandex Search API (пусто для OSM). */
  apiKey: string;
  /** Базовый URL Yandex Search API. */
  yandexEndpoint: string;
  /** URL Overpass API (OpenStreetMap). */
  overpassEndpoint: string;
  /** User-Agent для запросов к OSM (Overpass требует осмысленный UA). */
  userAgent: string;
  /** Язык ответа Yandex (например, ru_RU). */
  lang: string;
  /** Радиус поиска по умолчанию, метры. */
  defaultRadius: number;
  /** Сколько результатов отдавать по умолчанию. */
  defaultResults: number;
  /** Таймаут запроса, мс. */
  timeoutMs: number;
}

const DEFAULT_YANDEX_ENDPOINT = 'https://search-maps.yandex.ru/v1/';
const DEFAULT_OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';
const DEFAULT_USER_AGENT = 'ai-advent-places-mcp/1.0 (MCP server)';
const DEFAULT_LANG = 'ru_RU';
const DEFAULT_RADIUS_METERS = 1500;
const DEFAULT_RESULTS = 5;
const DEFAULT_TIMEOUT_MS = 15_000;

/** Целое не меньше 1 из env или значение по умолчанию. */
function parsePositiveInteger(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 ? value : fallback;
}

/**
 * Собирает конфигурацию поиска мест из окружения. Провайдер — PLACES_PROVIDER (osm|yandex),
 * по умолчанию osm (без ключей). Для yandex обязателен YANDEX_PLACES_API_KEY, иначе ошибка.
 */
export function loadPlacesConfig(env: NodeJS.ProcessEnv): PlacesConfig {
  const provider: PlacesProvider =
    env.PLACES_PROVIDER?.trim().toLowerCase() === 'yandex' ? 'yandex' : 'osm';
  const apiKey = env.YANDEX_PLACES_API_KEY?.trim() ?? '';
  if (provider === 'yandex' && apiKey === '') {
    throw new Error(
      'PLACES_PROVIDER=yandex требует YANDEX_PLACES_API_KEY (ключ Yandex Search API) — укажите в .env.',
    );
  }
  return {
    provider,
    apiKey,
    yandexEndpoint: env.YANDEX_PLACES_ENDPOINT?.trim() || DEFAULT_YANDEX_ENDPOINT,
    overpassEndpoint: env.OVERPASS_ENDPOINT?.trim() || DEFAULT_OVERPASS_ENDPOINT,
    userAgent: env.PLACES_USER_AGENT?.trim() || DEFAULT_USER_AGENT,
    lang: env.YANDEX_PLACES_LANG?.trim() || DEFAULT_LANG,
    defaultRadius: parsePositiveInteger(env.YANDEX_PLACES_RADIUS_M, DEFAULT_RADIUS_METERS),
    defaultResults: parsePositiveInteger(env.YANDEX_PLACES_RESULTS, DEFAULT_RESULTS),
    timeoutMs: parsePositiveInteger(env.YANDEX_PLACES_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  };
}
