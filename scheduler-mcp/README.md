# scheduler-mcp

MCP-сервер **планировщика отложенных и периодических задач** с фоновым исполнением. Работает
24/7: внутри держит фоновый цикл (`tick`), который сам по расписанию выполняет задачи и копит
результаты. Агент через MCP-инструменты ставит/снимает задачи и забирает историю («инбокс»).

> Изолированный пакет, **не часть ядра** `ai-advent`. Сознательно использует официальный
> `@modelcontextprotocol/sdk` + `zod` + `express` (как `yandex-ocr-mcp`). Остальные соглашения
> соблюдены: нативный TS без сборки, модульность, 100% покрытие логики.

## Фаза 1 (этот релиз)

Движок + хранилище + управляющие инструменты. Исполнители — **без LLM**: `http_check` (пинг URL,
доступность и латентность) и `note` (заметка/напоминание). Доставка результатов — pull через
`get_history`. (Фаза 2 — LLM-исполнитель, погода и гео, доставка в Telegram/системные уведомления;
Фаза 3 — сбор метрик и ежедневный отчёт.)

## Инструменты

| Инструмент | Назначение |
| ---------- | ---------- |
| `schedule_task` | Создать задачу: `kind` (`http_check`+`url` / `note`+`text`) и `schedule`. |
| `list_tasks` | Все задачи со статусом и следующим запуском. |
| `get_task` | Подробности задачи + последние запуски. |
| `cancel_task` / `pause_task` / `resume_task` | Удалить / пауза / возобновить. |
| `run_now` | Выполнить немедленно, не меняя расписание. |
| `get_history` | Результаты запусков (инбокс), новые первыми; опц. `taskId`/`limit`. |

Расписание (`schedule`): `{type:"interval",everySeconds}` | `{type:"daily",at:"HH:MM",tzOffsetMinutes}`
| `{type:"once",atIso}`. `tzOffsetMinutes` — смещение пояса в минутах (GMT+5 = 300).

## Запуск

```bash
npm install
cp .env.example .env   # впишите MCP_BEARER_TOKEN и PORT
npm start              # stdio (node src/cli.ts)
npm run start:http     # Streamable HTTP (node src/http.ts) — для VPS
```

## Команды

```bash
npm run typecheck       # tsc
npm test                # node:test + покрытие 100/100/100 (cli/server/http/runtime исключены)
npm run write-prettier  # форматирование
```

## Деплой на VPS (Streamable HTTP, под-путь за Caddy)

systemd-юнит — `deploy/scheduler-mcp.service` (секреты в `EnvironmentFile`). На общем VPS порт
`3001` (3000 занят `yandex-ocr-mcp`), за Caddy на под-пути `/scheduler` (с обрезкой префикса):

```
smartnfree.ru {
    handle_path /scheduler/* {
        reverse_proxy 127.0.0.1:3001
    }
    handle {
        reverse_proxy 127.0.0.1:3000
    }
}
```

Эндпоинт клиента: `https<хост>/scheduler/mcp` (Caddy срежет `/scheduler` → апстрим получит `/mcp`).
Подключение из `llm-cli` (`~/.llm-cli/mcp.json`):

```json
{ "mcpServers": { "scheduler": {
  "url": "https://smartnfree.ru/scheduler/mcp",
  "headers": { "Authorization": "Bearer <секрет>" }
} } }
```

## Структура

| Файл | Назначение |
| ---- | ---------- |
| `src/types.ts` | Типы: `Task`, `Schedule`, `TaskRun`, `SchedulerState`. |
| `src/schedule.ts` | Валидация расписаний и расчёт следующего срабатывания. |
| `src/task-store.ts` | `FileTaskStore` — JSON-состояние, атомарная запись. |
| `src/executors.ts` | Исполнители `http_check` / `note` (зависимости инжектируются). |
| `src/scheduler.ts` | Движок: CRUD задач, `tick`, история. |
| `src/tools.ts` | Обработчики MCP-инструментов (форматирование результата). |
| `src/config.ts` / `src/auth.ts` | Конфиг из env / bearer-авторизация. |
| `src/server.ts` | Тонкая обвязка: `McpServer` + регистрация инструментов. |
| `src/cli.ts` / `src/http.ts` | Точки входа stdio / HTTP. |
| `src/runtime.ts` | Сборка движка с реальными зависимостями + фоновый тик. |
