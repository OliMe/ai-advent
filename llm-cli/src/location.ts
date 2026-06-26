import type { ToolSet, ToolSpec } from '../../core/src/index.ts';

/** HTTP-клиент для геолокации (шов для тестов; реальный — глобальный fetch). */
export type LocationFetch = (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/** Приблизительное местоположение по IP. */
export interface ResolvedLocation {
  city: string;
  latitude: number;
  longitude: number;
}

/**
 * Определяет приблизительное местоположение по публичному IP (ipapi.co, без ключа). Делается на
 * КЛИЕНТЕ: на сервере IP указывал бы на датацентр. Бросает при недоступности/неожиданном ответе.
 */
export async function resolveLocation(fetchFn: LocationFetch = fetch): Promise<ResolvedLocation> {
  // ipwho.is: HTTPS, без ключа, поля latitude/longitude/city (ipapi.co упирался в RateLimited).
  const response = await fetchFn('https://ipwho.is/');
  if (!response.ok) {
    throw new Error('сервис геолокации недоступен');
  }
  const data = (await response.json()) as {
    city?: unknown;
    latitude?: unknown;
    longitude?: unknown;
  };
  if (typeof data.latitude !== 'number' || typeof data.longitude !== 'number') {
    throw new Error('неожиданный ответ геолокации');
  }
  return {
    city: typeof data.city === 'string' ? data.city : 'неизвестно',
    latitude: data.latitude,
    longitude: data.longitude,
  };
}

/**
 * Клиентский набор инструментов с одним инструментом get_my_location: агент вызывает его, когда
 * для задачи нужна локация (например погода), а пользователь не указал место явно.
 */
export class LocationToolSet implements ToolSet {
  private readonly fetchFn: LocationFetch;

  constructor(fetchFn: LocationFetch = fetch) {
    this.fetchFn = fetchFn;
  }

  specs(): ToolSpec[] {
    return [
      {
        name: 'get_my_location',
        description:
          'Определяет приблизительное местоположение пользователя (город и координаты) по IP. ' +
          'Используй, когда задаче нужна локация (например погода), а пользователь не указал место.',
        parameters: { type: 'object', properties: {} },
      },
    ];
  }

  async call(name: string, _args: Record<string, unknown>): Promise<string> {
    if (name !== 'get_my_location') {
      throw new Error(`Неизвестный инструмент: ${name}`);
    }
    const location = await resolveLocation(this.fetchFn);
    return `Местоположение: ${location.city}, latitude=${location.latitude}, longitude=${location.longitude}`;
  }
}
