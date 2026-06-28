# places-mcp

MCP-сервер **поиска организаций рядом**. Один инструмент `find_places`: по тексту запроса и
координатам возвращает ближайшие места (расстояние, адрес, телефон, часы), отсортированные по
близости. Координаты агент берёт из клиентского `get_my_location` в `llm-cli` — получается
кросс-серверный флоу «геолокация → места → файл/планировщик».

> Изолированный пакет, **не часть ядра** `ai-advent`. Сознательно использует официальный
> `@modelcontextprotocol/sdk` + `zod` (как `yandex-ocr-mcp`/`filesystem-mcp`). Нативный TS без
> сборки, модульность, 100% покрытие логики (тонкие `server.ts`/`cli.ts` вне покрытия).

## Переключаемые провайдеры данных

Источник выбирается переменной `PLACES_PROVIDER` (по умолчанию `osm`):

- **`osm`** — [OpenStreetMap Overpass API](https://overpass-api.de): **без ключей**, бесплатно.
  POI по тегам в радиусе (словарь категория→OSM-тег: аптека→`amenity=pharmacy`, кафе, банкомат,
  банк, заправка, продукты, больница, парк…), для незнакомых запросов — фолбэк по имени.
- **`yandex`** — Yandex Search API (поиск по организациям): богаче (часы, телефон), но требует
  `YANDEX_PLACES_API_KEY`. ⚠ На момент написания сервис **закрыт за платный/согласованный доступ**
  (новые ключи отвечают «Invalid api key» / «сервис заблокирован») — оставлен на будущее.

Оба провайдера скрыты за общим контрактом `PlaceProvider`; расстояние считается гаверсинусом и
результат сортируется по близости на нашей стороне.

## Инструмент

| Инструмент | Аргументы | Результат |
| ---------- | --------- | --------- |
| `find_places` | `text` (что искать), `latitude`, `longitude`, опц. `radius` (м), `limit` | Нумерованный список: 📍 название · ~расстояние · адрес · ☎ телефон · 🕒 часы · 📌 координаты |

## Настройка

```bash
npm install
# .env не обязателен для OSM. Для Yandex:
cp .env.example .env   # PLACES_PROVIDER=yandex + YANDEX_PLACES_API_KEY
```

| Переменная | Назначение | По умолчанию |
| ---------- | ---------- | ------------ |
| `PLACES_PROVIDER` | `osm` или `yandex` | `osm` |
| `YANDEX_PLACES_API_KEY` | Ключ Yandex Search API (нужен при `yandex`) | — |
| `OVERPASS_ENDPOINT` | URL Overpass API | `https://overpass-api.de/api/interpreter` |
| `YANDEX_PLACES_ENDPOINT` | URL Yandex Search API | `https://search-maps.yandex.ru/v1/` |
| `PLACES_USER_AGENT` | User-Agent для OSM | `ai-advent-places-mcp/…` |
| `YANDEX_PLACES_LANG` | Язык ответа Yandex | `ru_RU` |
| `YANDEX_PLACES_RADIUS_M` | Радиус поиска по умолчанию, м | `1500` |
| `YANDEX_PLACES_RESULTS` | Результатов по умолчанию | `5` |
| `YANDEX_PLACES_TIMEOUT_MS` | Таймаут запроса, мс | `15000` |

## Подключение к `llm-cli`

OSM-провайдер ключей не требует, поэтому достаточно:

```
/mcp add places node /путь/к/places-mcp/src/cli.ts
```

Дальше агент сам вызывает `get_my_location` → `places__find_places` по запросу вроде
«найди ближайшую аптеку и добавь в список дел».

## Команды

```bash
npm run typecheck       # tsc
npm test                # node:test + покрытие 100/100/100 (server/cli исключены)
npm run write-prettier  # форматирование
```

## Структура

| Файл | Назначение |
| ---- | ---------- |
| `src/geo.ts` | Общие типы (`Place`/`FindPlacesQuery`/`PlaceProvider`/`FetchLike`) и утилиты (гаверсинус, сортировка, `pick`/`asString`). |
| `src/provider-osm.ts` | Провайдер OpenStreetMap Overpass: словарь категорий, сборка запроса, разбор `node`/`way`. |
| `src/provider-yandex.ts` | Провайдер Yandex Search API: запрос + разбор GeoJSON. |
| `src/provider.ts` | Выбор провайдера по конфигу. |
| `src/config.ts` | Конфиг из окружения (провайдер, ключ, эндпоинты, дефолты). |
| `src/format.ts` | Форматирование списка мест в текст. |
| `src/tools.ts` | Обработчик `find_places` (валидация аргументов). |
| `src/server.ts` / `src/cli.ts` | Тонкая обвязка: `McpServer` + stdio (вне покрытия). |
