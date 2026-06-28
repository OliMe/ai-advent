import type { PlacesConfig } from './config.ts';
import type { FetchLike, FindPlacesQuery, Place, PlaceProvider } from './geo.ts';
import { asString, haversineMeters, nearestFirst, pick } from './geo.ts';

/** Словарь «категория (рус.) → OSM-фильтр Overpass». Ключ ищется как подстрока запроса. */
const CATEGORY_FILTERS: Record<string, string> = {
  аптек: '[amenity=pharmacy]',
  кофе: '[amenity=cafe]',
  кафе: '[amenity=cafe]',
  ресторан: '[amenity=restaurant]',
  бар: '[amenity=bar]',
  банкомат: '[amenity=atm]',
  банк: '[amenity=bank]',
  заправк: '[amenity=fuel]',
  азс: '[amenity=fuel]',
  супермаркет: '[shop=supermarket]',
  продукт: '[shop=convenience]',
  магазин: '[shop]',
  больниц: '[amenity=hospital]',
  поликлиник: '[amenity=clinic]',
  школ: '[amenity=school]',
  парк: '[leisure=park]',
  метро: '[station=subway]',
  почт: '[amenity=post_office]',
};

/** Подбирает OSM-фильтр по запросу: известная категория или поиск по имени (фолбэк). */
export function resolveFilter(text: string): string {
  const lower = text.toLowerCase();
  for (const [keyword, filter] of Object.entries(CATEGORY_FILTERS)) {
    if (lower.includes(keyword)) {
      return filter;
    }
  }
  const escaped = text.replace(/["\\]/g, '\\$&');
  return `[name~"${escaped}",i]`;
}

/** Собирает Overpass-запрос: POI выбранной категории в радиусе вокруг точки. */
export function buildOverpassQuery(
  filter: string,
  latitude: number,
  longitude: number,
  radius: number,
  count: number,
): string {
  return `[out:json][timeout:25];nwr(around:${radius},${latitude},${longitude})${filter};out center ${count};`;
}

/** Адрес из OSM-тегов: «улица, дом» / только улица / пусто. */
function addressFromTags(tags: unknown): string {
  const street = asString(pick(tags, 'addr:street'));
  if (street === undefined) {
    return '';
  }
  const house = asString(pick(tags, 'addr:housenumber'));
  return house === undefined ? street : `${street}, ${house}`;
}

/** Разбирает ответ Overpass в список мест, считает расстояние и сортирует по близости. */
export function parseOverpassResponse(
  json: unknown,
  centerLat: number,
  centerLon: number,
  limit: number,
): Place[] {
  const elements = pick(json, 'elements');
  if (!Array.isArray(elements)) {
    return [];
  }
  const places: Place[] = [];
  for (const element of elements) {
    const center = pick(element, 'center');
    const latitude = Number(pick(element, 'lat') ?? pick(center, 'lat'));
    const longitude = Number(pick(element, 'lon') ?? pick(center, 'lon'));
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      continue;
    }
    const tags = pick(element, 'tags');
    const name = asString(pick(tags, 'name')) ?? 'без названия';
    const phone = asString(pick(tags, 'phone')) ?? asString(pick(tags, 'contact:phone'));
    const hours = asString(pick(tags, 'opening_hours'));
    places.push({
      name,
      address: addressFromTags(tags),
      latitude,
      longitude,
      distanceMeters: haversineMeters(centerLat, centerLon, latitude, longitude),
      ...(phone ? { phone } : {}),
      ...(hours ? { hours } : {}),
    });
  }
  return nearestFirst(places, limit);
}

/** Ищет места рядом через OpenStreetMap Overpass API (без ключей). */
export async function osmFindPlaces(
  fetchFn: FetchLike,
  config: PlacesConfig,
  query: FindPlacesQuery,
): Promise<Place[]> {
  const overpassQuery = buildOverpassQuery(
    resolveFilter(query.text),
    query.latitude,
    query.longitude,
    query.radius,
    query.limit * 4, // берём с запасом — Overpass не сортирует по расстоянию, режем после сортировки
  );
  const response = await fetchFn(config.overpassEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', 'User-Agent': config.userAgent },
    body: overpassQuery,
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Overpass API вернул ошибку HTTP ${response.status}.`);
  }
  return parseOverpassResponse(await response.json(), query.latitude, query.longitude, query.limit);
}

/** Провайдер мест поверх OpenStreetMap Overpass. */
export function createOsmProvider(fetchFn: FetchLike, config: PlacesConfig): PlaceProvider {
  return { findPlaces: query => osmFindPlaces(fetchFn, config, query) };
}
