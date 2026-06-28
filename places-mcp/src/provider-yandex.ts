import type { PlacesConfig } from './config.ts';
import type { FetchLike, FindPlacesQuery, Place, PlaceProvider } from './geo.ts';
import { asString, haversineMeters, nearestFirst, pick } from './geo.ts';

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
  return nearestFirst(places, limit);
}

/** Ищет организации по тексту рядом с координатами через Yandex Search API. */
export async function yandexFindPlaces(
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
  const response = await fetchFn(`${config.yandexEndpoint}?${params.toString()}`, {
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

/** Провайдер мест поверх Yandex Search API. */
export function createYandexProvider(fetchFn: FetchLike, config: PlacesConfig): PlaceProvider {
  return { findPlaces: query => yandexFindPlaces(fetchFn, config, query) };
}
