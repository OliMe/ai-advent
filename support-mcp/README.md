# support-mcp

MCP-**сервер** доступа к тикет-системе как к CRM. Даёт ассистенту поддержки обобщённый
**ticket-контракт**, поэтому под любой трекер/CRM (GitHub Issues, GitLab, Jira, Zendesk, JSON)
достаточно нового провайдера — код бота не меняется.

## Инструменты (отдают строгий JSON)

| Инструмент | Назначение |
| ---------- | ---------- |
| `get_ticket` (`id`) | Тикет по id |
| `list_tickets` (`limit?`) | Открытые тикеты |
| `search_tickets` (`query`, `limit?`) | Поиск тикетов по тексту |
| `get_ticket_comments` (`id`) | Тред комментариев (диалог поддержки) |
| `add_ticket_comment` (`id`, `body`) | Ответить в тред (тело помечается скрытым маркером бота) |

Доменные типы (`Ticket`/`TicketComment`/`TicketUser`) — обобщённые, не форма GitHub.

## Провайдеры (шов замены CRM)

`TicketProvider` + `createProvider(config, fetch, sleep)`. Пока единственный — **GitHub Issues**
(`provider-github.ts`, поверх `core.requestJson`: пагинация тредов, отсев PR, `isBot` по маркеру).
Чтобы добавить GitLab/Jira/Zendesk/JSON — новый `provider-*.ts` и ветка в `createProvider`.

## Переменные окружения

| Переменная | Назначение |
| ---------- | ---------- |
| `SUPPORT_REPO` | Репозиторий-трекер `owner/name` (или `GITHUB_REPOSITORY`) |
| `SUPPORT_TOKEN` | Токен доступа (или `GITHUB_TOKEN`/`GH_TOKEN`); нужны права на issues (чтение+запись) |
| `SUPPORT_API_URL` | База API (или `GITHUB_API_URL`); дефолт `https://api.github.com` (Enterprise — свой URL) |
| `SUPPORT_MAX_OUTPUT_CHARS` | Потолок вывода инструмента (дефолт 8000) |

## Запуск

```bash
# stdio (для подключения из бота/клиента):
SUPPORT_REPO=owner/name SUPPORT_TOKEN=… node support-mcp/src/cli.ts
```

## Структура

| Файл | Назначение |
| ---- | ---------- |
| `src/types.ts` | Обобщённые доменные типы |
| `src/provider.ts` | Интерфейс `TicketProvider` + шов `createProvider` |
| `src/provider-github.ts` | Провайдер GitHub Issues (через `core.requestJson`) |
| `src/loop-guard.ts` | Маркер бота `<!-- ai-support -->` + `markComment`/`hasSupportMarker` |
| `src/config.ts` | Конфигурация из окружения |
| `src/tools.ts` | 5 инструментов (строгий JSON, усечение вывода) |
| `src/server.ts` / `src/cli.ts` | Тонкая проводка к MCP SDK (stdio), вне покрытия |
