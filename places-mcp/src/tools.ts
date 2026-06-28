import type { PlacesConfig } from './config.ts';
import type { PlaceProvider } from './geo.ts';
import { formatPlaces } from './format.ts';

/** Зависимости обработчика: конфиг (для дефолтов) и провайдер мест. */
export interface ToolDeps {
  config: PlacesConfig;
  provider: PlaceProvider;
}

/** Текст ошибки из неизвестного значения. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Непустая строка из аргумента или null. */
function stringArg(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** Конечное число из аргумента или null. */
function numberArg(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Ищет организации рядом и форматирует результат; нужны text + координаты. */
export async function handleFindPlaces(
  deps: ToolDeps,
  args: Record<string, unknown>,
): Promise<string> {
  const text = stringArg(args.text);
  if (text === null) {
    return 'Нужен непустой text (что искать рядом, например «аптека»).';
  }
  const latitude = numberArg(args.latitude);
  const longitude = numberArg(args.longitude);
  if (latitude === null || longitude === null) {
    return 'Нужны числовые latitude и longitude (координаты точки поиска).';
  }
  const radius = numberArg(args.radius) ?? deps.config.defaultRadius;
  const limit = numberArg(args.limit) ?? deps.config.defaultResults;
  try {
    const places = await deps.provider.findPlaces({ text, latitude, longitude, radius, limit });
    return formatPlaces(text, places);
  } catch (error) {
    return errorText(error);
  }
}
