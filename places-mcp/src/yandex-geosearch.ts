import type { PlacesConfig } from './config.ts';

/** Найденная организация рядом. */
export interface Place {
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  /** Расстояние от точки запроса, метры. */
  distanceMeters: number;
  phone?: string;
  hours?: string;
  url?: string;
}

/** Параметры поиска организаций. */
export interface FindPlacesQuery {
  text: string;
  latitude: number;
  longitude: number;
  radius: number;
  limit: number;
}

/** Узкий контракт fetch (инжектируется для тестируемости). */
export type FetchLike = (
  url: string,
  init: { method: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Безопасно достаёт поле объекта (или undefined для не-объектов). */
function pick(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** Строка из значения или undefined. */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** Расстояние между двумя точками на сфере (метры, формула гаверсинуса). */
export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const earthRadius = 6_371_000;
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const deltaLat = toRadians(lat2 - lat1);
  const deltaLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(deltaLon / 2) ** 2;
  return Math.round(earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

/** Размах окна поиска (градусы) для радиуса в метрах вокруг широты. */
function spanFromRadius(
  latitude: number,
  radiusMeters: number,
): { spanLon: number; spanLat: number } {
  const metersPerDegreeLat = 111_320;
  const spanLat = radiusMeters / metersPerDegreeLat;
  const spanLon = radiusMeters / (metersPerDegreeLat * Math.cos((latitude * Math.PI) / 180));
  return { spanLon: spanLon * 2, spanLat: spanLat * 2 };
}

/** Первый отформатированный телефон из CompanyMetaData.Phones. */
function firstPhone(companyMeta: unknown): string | undefined {
  const phones = pick(companyMeta, 'Phones');
  if (!Array.isArray(phones) || phones.length === 0) {
    return undefined;
  }
  return asString(pick(phones[0], 'formatted'));
}

/** Разбирает GeoJSON-ответ Geosearch в список мест, считает расстояние и сортирует по близости. */
export function parseGeosearchResponse(
  json: unknown,
  centerLat: number,
  centerLon: number,
  limit: number,
): Place[] {
  const features = pick(json, 'features');
  if (!Array.isArray(features)) {
    return [];
  }
  const places: Place[] = [];
  for (const feature of features) {
    const coordinates = pick(pick(feature, 'geometry'), 'coordinates');
    if (!Array.isArray(coordinates) || coordinates.length < 2) {
      continue;
    }
    const longitude = Number(coordinates[0]);
    const latitude = Number(coordinates[1]);
    const properties = pick(feature, 'properties');
    const companyMeta = pick(properties, 'CompanyMetaData');
    const name =
      asString(pick(companyMeta, 'name')) ?? asString(pick(properties, 'name')) ?? 'без названия';
    const address =
      asString(pick(companyMeta, 'address')) ?? asString(pick(properties, 'description')) ?? '';
    const phone = firstPhone(companyMeta);
    const hours = asString(pick(pick(companyMeta, 'Hours'), 'text'));
    const url = asString(pick(companyMeta, 'url'));
    places.push({
      name,
      address,
      latitude,
      longitude,
      distanceMeters: haversineMeters(centerLat, centerLon, latitude, longitude),
      ...(phone ? { phone } : {}),
      ...(hours ? { hours } : {}),
      ...(url ? { url } : {}),
    });
  }
  return places.sort((a, b) => a.distanceMeters - b.distanceMeters).slice(0, limit);
}

/** Ищет организации по тексту рядом с координатами через Yandex Search API. */
export async function findPlaces(
  fetchFn: FetchLike,
  config: PlacesConfig,
  query: FindPlacesQuery,
): Promise<Place[]> {
  const span = spanFromRadius(query.latitude, query.radius);
  const params = new URLSearchParams({
    apikey: config.apiKey,
    text: query.text,
    lang: config.lang,
    ll: `${query.longitude},${query.latitude}`,
    spn: `${span.spanLon.toFixed(6)},${span.spanLat.toFixed(6)}`,
    type: 'biz',
    results: String(query.limit),
  });
  const response = await fetchFn(`${config.endpoint}?${params.toString()}`, {
    method: 'GET',
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Yandex Search API вернул ошибку HTTP ${response.status}.`);
  }
  return parseGeosearchResponse(
    await response.json(),
    query.latitude,
    query.longitude,
    query.limit,
  );
}
