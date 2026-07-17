# support-bot

Автономный **ассистент поддержки в GitHub Issues**. По открытию issue или новому комментарию читает
тред через `support-mcp` (CRM), отвечает на вопрос о продукте по **FAQ** (RAG + цитатный гейт) с
учётом контекста тикета и **постит ответ комментарием**. Многоходовость = ветка комментариев.

## Как работает ход (детерминированный — инструменты зовём МЫ, не модель)

```
issue/comment → cli.ts
  1. readTicketThread()  ← тикет + тред через support-mcp (get_ticket/get_ticket_comments)
  2. защита от петли      ← последний комментарий с маркером бота → ничего не делаем
  3. pickQuestion()       ← последняя реплика пользователя (или описание тикета)
  4. retrieveDocChunks()  ← FAQ по вопросу (кэш индекса, grounding)
  5. answerSupportQuestion() ← tool-free синтез → цитатный гейт (источники ⊂ FAQ + дословная цитата)
  6. постобработка        ← «Источники» → ссылки на файл+раздел; снять ярлык «Ответ:»; цитата вопроса
  7. postReply()          ← ответ в тред через support-mcp (add_ticket_comment, помечается маркером)
```

**CRM только через MCP-контракт** — единица замены трекера/CRM. **Анти-галлюцинация:** ответ по FAQ,
источники и цитаты сверяются с фрагментами; FAQ не покрывает вопрос → честное «не знаю» (лучше, чем
неверный ответ). **Защита от петли** многослойная: событие от бота не триггерит Action (natural), плюс
фильтр `sender.type != 'Bot'`, плюс код-гейт по маркеру.

## FAQ

`faq/*.md` — по одному вопросу на `##`-заголовок (лучший чанкинг). Продукт — сервисы ai-advent
(авторизация, настройка эмбеддингов/MCP/моделей, устранение неполадок).

## Переменные окружения

| Переменная | Назначение |
| ---------- | ---------- |
| `SUPPORT_REPO` | `owner/name` (в Actions — `${{ github.repository }}`) |
| `SUPPORT_ISSUE_NUMBER` | Номер тикета (в Actions — `${{ github.event.issue.number }}`) |
| `SUPPORT_TOKEN` / `GITHUB_TOKEN` | Токен (нужны права issues: write) |
| `LLM_*` | Модель ответа (`LLM_BASE_URL` — полный URL `/chat/completions`) |
| `LLM_EMBEDDINGS_*` | Эмбеддинги для RAG по FAQ |
| `SUPPORT_FAQ_DIR` / `SUPPORT_CACHE_DIR` | Каталоги FAQ и кэша (дефолт — рядом с пакетом) |
| `SUPPORT_NO_THINKING=1` | Гасит рассуждения модели (нужно GLM) |

## Запуск

```bash
# Прогрев индекса FAQ (нужен только эмбеддер):
LLM_EMBEDDINGS_URL=… node support-bot/src/cli.ts --warm-cache

# Ответ на тикет (нужны CRM-токен + модель + эмбеддер):
SUPPORT_REPO=owner/name SUPPORT_ISSUE_NUMBER=7 GITHUB_TOKEN=… LLM_*=… node support-bot/src/cli.ts
```

## Подключение к репозиторию (GitHub Action)

Для этого репозитория — `.github/workflows/ai-support.yml` (+ фоновый прогрев
`ai-support-index.yml`). Для **любого другого** — скопируйте `docs/ai-support-workflow.yml` как
`.github/workflows/ai-support.yml`, положите свой FAQ в `faq/*.md` и задайте секреты/переменные
`LLM_*`. Триггер — `on: issues:[opened], issue_comment:[created]`.

## Структура

| Файл | Назначение |
| ---- | ---------- |
| `src/ticket-client.ts` | Детерминированный потребитель CRM через MCP (stdio) |
| `src/ticket-context.ts` | Контекст тикета для промпта + выбор вопроса |
| `src/answer.ts` | Синтез ответа + цитатный гейт (`grounding`) |
| `src/flow.ts` | Оркестрация + защита от петли |
| `src/config.ts` | Конфигурация из окружения |
| `src/cli.ts` | Проводка: MCP-коннект, RAG, постинг (вне покрытия) |
