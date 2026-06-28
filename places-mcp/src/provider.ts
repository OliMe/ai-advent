import type { PlacesConfig } from './config.ts';
import type { FetchLike, PlaceProvider } from './geo.ts';
import { createYandexProvider } from './provider-yandex.ts';
import { createOsmProvider } from './provider-osm.ts';

/** Выбирает провайдера мест по конфигу: Yandex Search API или OpenStreetMap. */
export function createProvider(config: PlacesConfig, fetchFn: FetchLike): PlaceProvider {
  return config.provider === 'yandex'
    ? createYandexProvider(fetchFn, config)
    : createOsmProvider(fetchFn, config);
}
