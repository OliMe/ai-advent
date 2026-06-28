/** Общие типы и утилиты поиска мест (используют оба провайдера: Yandex и OSM). */

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

/** Источник данных о местах: Yandex Search API или OpenStreetMap (общий контракт). */
export interface PlaceProvider {
  findPlaces(query: FindPlacesQuery): Promise<Place[]>;
}

/** Узкий контракт fetch (инжектируется для тестируемости; body/headers — для POST к Overpass). */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers?: Record<string, string>;
    body?: string;
    signal: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Безопасно достаёт поле объекта (или undefined для не-объектов). */
export function pick(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** Непустая строка из значения или undefined. */
export function asString(value: unknown): string | undefined {
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

/** Сортирует места по близости и берёт не больше limit. */
export function nearestFirst(places: Place[], limit: number): Place[] {
  return places.sort((a, b) => a.distanceMeters - b.distanceMeters).slice(0, limit);
}
