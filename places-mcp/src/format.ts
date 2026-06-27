import type { Place } from './yandex-geosearch.ts';

/** Человекочитаемое расстояние: метры до 1 км, иначе километры. */
function formatDistance(meters: number): string {
  return meters < 1000 ? `${meters} м` : `${(meters / 1000).toFixed(1)} км`;
}

/** Форматирует список мест для ответа MCP-инструмента (нумерованный, с адресом/телефоном/часами). */
export function formatPlaces(text: string, places: Place[]): string {
  if (places.length === 0) {
    return `По запросу «${text}» рядом ничего не найдено.`;
  }
  return places
    .map((place, index) => {
      const lines = [`${index + 1}. 📍 ${place.name} — ~${formatDistance(place.distanceMeters)}`];
      if (place.address) {
        lines.push(`   ${place.address}`);
      }
      if (place.phone) {
        lines.push(`   ☎ ${place.phone}`);
      }
      if (place.hours) {
        lines.push(`   🕒 ${place.hours}`);
      }
      lines.push(`   📌 ${place.latitude.toFixed(6)}, ${place.longitude.toFixed(6)}`);
      return lines.join('\n');
    })
    .join('\n');
}
