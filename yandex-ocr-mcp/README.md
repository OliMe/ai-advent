# yandex-ocr-mcp

MCP-сервер распознавания текста на изображениях через **Yandex Vision OCR**. Поднимается по
stdio и даёт LLM-агенту один инструмент — `recognize-text`.

> Изолированный пакет, **не часть ядра** `ai-advent`. Сознательно использует официальный
> `@modelcontextprotocol/sdk` и `zod` (как `mcp-probe`) — осознанное исключение из правила
> «без сторонних SDK». Остальные договорённости соблюдены: нативный TS без сборки,
> модульность, `tsconfig`/prettier, 100% покрытие логики.

## Установка

```bash
cd yandex-ocr-mcp && npm install
cp .env.example .env   # впишите YANDEX_OCR_API_KEY
```

## Настройка (`.env`)

| Переменная             | Назначение                                                              |
| ---------------------- | ----------------------------------------------------------------------- |
| `YANDEX_OCR_API_KEY`   | API-ключ сервисного аккаунта (приоритетный способ авторизации).         |
| `YANDEX_IAM_TOKEN`     | Альтернатива — IAM-токен (Bearer), живёт ~12 часов.                     |
| `YANDEX_FOLDER_ID`     | Каталог (`x-folder-id`), нужен при авторизации IAM-токеном.            |
| `YANDEX_OCR_MODEL`     | Модель по умолчанию (`page` по умолчанию; `handwritten`, `table`, …).  |
| `YANDEX_OCR_LANGUAGES` | Языки по умолчанию через запятую (`*` — все).                          |
| `YANDEX_OCR_ENDPOINT`  | Переопределение URL распознавания.                                     |
| `YANDEX_OCR_TIMEOUT_MS`| Таймаут запроса, мс (по умолчанию 60000).                              |

## Инструмент `recognize-text`

Вход (ровно один источник изображения):

| Поле           | Назначение                                                      |
| -------------- | --------------------------------------------------------------- |
| `path`         | Путь к локальному файлу изображения/одностраничного PDF.        |
| `url`          | Ссылка на изображение (сервер скачает).                         |
| `base64`       | Содержимое изображения в base64.                                |
| `mimeType`     | Опц. MIME-тип (иначе — по расширению/Content-Type/дефолт).      |
| `languageCodes`| Опц. языки (иначе из `.env`).                                   |
| `model`        | Опц. модель (иначе из `.env`).                                  |

Возвращает распознанный текст (`fullText`) текстовым блоком.

## Запуск

Это stdio-сервер — его запускает MCP-клиент. Подключить можно из любого MCP-клиента,
указав команду запуска `node src/cli.ts` (рабочий каталог — этот пакет, чтобы подхватился `.env`).

Проверить, что сервер виден и отдаёт инструмент, можно соседним пакетом `mcp-probe` (без
ключа Yandex — для `tools/list` ключ не нужен, достаточно любого значения, чтобы сервер стартовал):

```bash
cd ../mcp-probe
MCP_COMMAND=node \
  MCP_ARGS="$(cd ../yandex-ocr-mcp && pwd)/src/cli.ts" \
  YANDEX_OCR_API_KEY=dummy \
  npm start
# вызвать распознавание (нужен настоящий ключ в окружении сервера):
#   npm start -- recognize-text '{"path":"/путь/к/скану.png"}'
```

## Команды

```bash
npm run typecheck       # tsc (только проверка типов)
npm test                # node:test + покрытие, порог 100/100/100 (cli.ts/server.ts исключены)
npm run write-prettier  # форматирование
```

## Структура

| Файл                  | Назначение                                                            |
| --------------------- | --------------------------------------------------------------------- |
| `src/config.ts`       | Разбор `.env` → авторизация, endpoint, модель, языки, таймаут          |
| `src/image-source.ts` | Резолв источника (path/url/base64) → base64 + MIME; `inferMimeType`    |
| `src/yandex-ocr.ts`   | Вызов Yandex OCR (`recognizeText`) и разбор ответа (`parseOcrResponse`)|
| `src/recognize-tool.ts`| `runRecognizeText`: источник → OCR → MCP-ответ                        |
| `src/auth.ts`         | Bearer-авторизация HTTP (чистая логика, покрыта тестами)               |
| `src/server.ts`       | Тонкая обвязка: `McpServer` + регистрация инструмента                  |
| `src/cli.ts`          | Точка входа (stdio): `.env`, `StdioServerTransport`                    |
| `src/http.ts`         | Точка входа (Streamable HTTP): express + bearer-auth, для VPS          |
| `src/index.ts`        | Barrel — реэкспорт логики                                             |

## Деплой на VPS (Streamable HTTP)

По умолчанию сервер работает по **stdio** (локально, клиент запускает процесс рядом). Для
удалённого доступа есть **HTTP-режим** (Streamable HTTP) с проверкой bearer-токена:

```bash
PORT=3000 MCP_BEARER_TOKEN=<секрет> YANDEX_OCR_API_KEY=<ключ> npm run start:http
```

- Эндпоинт: `POST /mcp`. Без верного `Authorization: Bearer <токен>` — `401`.
- `MCP_BEARER_TOKEN` **обязателен** для публичного VPS (иначе любой сможет тратить твою
  квоту Yandex). Пусто — авторизация выключена (только за доверенным прокси).

**Docker:**

```bash
docker build -t yandex-ocr-mcp .
docker run -p 3000:3000 \
  -e YANDEX_OCR_API_KEY=<ключ> -e MCP_BEARER_TOKEN=<секрет> \
  yandex-ocr-mcp
```

**systemd:** юнит — `deploy/yandex-ocr-mcp.service` (секреты в `EnvironmentFile`). Перед
публичным доступом поставь TLS-реверс-прокси (nginx/Caddy) и держи app на `127.0.0.1`.

**Подключение клиента** (`~/.llm-cli/mcp.json` или `mcp-probe`):

```json
{ "mcpServers": { "yandex": { "url": "https://your-host/mcp", "headers": { "Authorization": "Bearer <секрет>" } } } }
```

> Безопасность: сервер не логирует ключи; bearer-проверка — в `src/auth.ts` (покрыта тестами).
> HTTP-обвязка (`src/http.ts`) тонкая и исключена из покрытия, как `cli.ts`/`server.ts`.

## Дальше (не в v1)

Структурный вывод (блоки/таблицы), многостраничный PDF через асинхронный `recognizeTextAsync`.
