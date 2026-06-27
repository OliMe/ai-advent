import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatPlaces } from '../index.ts';
import type { Place } from '../index.ts';

describe('formatPlaces', () => {
  it('пусто → сообщение «ничего не найдено»', () => {
    assert.match(formatPlaces('аптека', []), /По запросу «аптека» рядом ничего не найдено/);
  });

  it('близкое место со всеми полями: метры, адрес, телефон, часы, координаты', () => {
    const place: Place = {
      name: 'Аптека 36.6',
      address: 'ул. Тверская, 1',
      latitude: 55.751,
      longitude: 37.605,
      distanceMeters: 240,
      phone: '+7 495 000-00-00',
      hours: 'круглосуточно',
      url: 'https://x',
    };
    const out = formatPlaces('аптека', [place]);
    assert.match(out, /1\. 📍 Аптека 36\.6 — ~240 м/);
    assert.match(out, /ул\. Тверская, 1/);
    assert.match(out, /☎ \+7 495 000-00-00/);
    assert.match(out, /🕒 круглосуточно/);
    assert.match(out, /📌 55\.751000, 37\.605000/);
  });

  it('дальнее место без адреса/телефона/часов: километры, без лишних строк', () => {
    const place: Place = {
      name: 'Дальняя аптека',
      address: '',
      latitude: 55.8,
      longitude: 37.7,
      distanceMeters: 2400,
    };
    const out = formatPlaces('аптека', [place]);
    assert.match(out, /~2\.4 км/);
    assert.doesNotMatch(out, /☎/);
    assert.doesNotMatch(out, /🕒/);
    assert.doesNotMatch(out, /\n {3}\S.*\n {3}☎/); // нет строки адреса перед телефоном
  });
});
