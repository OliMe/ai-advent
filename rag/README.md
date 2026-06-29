# rag

RAG-индексатор: загрузка документов из разных источников → разбиение на чанки → эмбеддинги →
локальный индекс с метаданными. Плюс сравнение стратегий чанкинга и косинус-ретрив.

> Импортирует `core` (`EmbeddingsClient`). Нативный TS без сборки, 100% покрытие логики;
> тонкие `src/cli.ts` и `src/sources/node-io.ts` (реальные fs/fetch/tar) — вне покрытия.

## Пайплайн

1. **Источник** (автоопределение по строке): локальная папка / GitHub-URL (скачивание tarball) /
   URL документации (обход по ссылкам в пределах origin, глубина — параметр).
2. **Чанкинг — 2 стратегии:**
   - `fixed` — по размеру (символы) с перекрытием overlap; ровные предсказуемые куски;
   - `structural` — по структуре: markdown по заголовкам (`##…`), код по файлам; огромный
     раздел до-резается, сохраняя имя раздела. Куски цельные, метаданные осмысленные.
3. **Эмбеддинги:** `core.EmbeddingsClient` (OpenAI-совместимый `/embeddings`). По умолчанию —
   локальный **Ollama** (`nomic-embed-text`); меняется на любой удалённый сервис через окружение
   (`LLM_EMBEDDINGS_URL/MODEL/API_KEY`) без правок кода.
4. **Индекс:** JSON за интерфейсом `IndexStore` (позже сменяемо на sqlite/бинарь). На каждый чанк —
   метаданные: `source`, `file`, `title`, `section`, `chunk_id` + вектор.

## Команды

```bash
# собрать индекс одной стратегией
rag build <источник> --strategy fixed --out docs.fixed.index.json
rag build <источник> --strategy structural

# сравнить 2 стратегии (таблица: число чанков, размеры, покрытие section)
rag compare <источник>

# ретрив: top-k чанков по косинусной близости (с метаданными)
rag query <файл-индекса> <запрос…> --k 5
```

Флаги: `--depth N` (глубина веб-обхода, дефолт 2), `--size`/`--overlap` (fixed, дефолт 2000/256),
`--max-size` (structural, дефолт 2000). Источник — путь к папке, ссылка на github.com или URL
страницы документации.

Пример (корпус — сам проект):

```bash
node src/cli.ts compare /путь/к/ai-advent/llm-cli
node src/cli.ts query llm-cli.structural.index.json как работает голосовой ввод --k 3
```

## Настройка эмбеддингов

По умолчанию ничего настраивать не нужно — поднимите Ollama:

```bash
ollama serve
ollama pull nomic-embed-text
```

Сменить провайдер (на удалённый OpenAI-совместимый) — задать в `.env`:

```bash
LLM_EMBEDDINGS_URL=https://api.example/v1/embeddings
LLM_EMBEDDINGS_MODEL=text-embedding-3-small
LLM_EMBEDDINGS_API_KEY=ключ      # для Ollama не нужен
```

## Команды разработки

```bash
npm run typecheck       # tsc
npm test                # node:test + покрытие 100/100/100 (cli/node-io исключены)
npm run write-prettier  # форматирование
```

## Структура

| Файл | Назначение |
| ---- | ---------- |
| `src/types.ts` | Типы: `Document`, `Chunk`, `IndexedChunk`, `Index`. |
| `src/chunkers.ts` | Стратегии `fixed`/`structural` + диспетчер. |
| `src/cosine.ts` | Косинусная близость + `topK`. |
| `src/index-builder.ts` | Сборка индекса: чанкинг + батч-эмбеддинг (инжектируемый `EmbedFn`). |
| `src/index-store.ts` | `IndexStore` + `JsonIndexStore`. |
| `src/stats.ts` | Статистика индекса для сравнения стратегий. |
| `src/sources/` | Источники: `local`/`web`/`github`/`resolve` (логика) + `node-io` (реальный IO, вне покрытия). |
| `src/cli.ts` | Точка входа `build`/`compare`/`query` (вне покрытия). |

## Подключение к чату (на потом)

Day 21 — это индексация. Ретрив встроится в `llm-cli` как инструмент `search_docs` (вероятно
отдельным `rag-mcp`-сервером): агент сам зовёт его на вопросы про индексированные документы,
получает top-k чанков с метаданными и отвечает по ним со ссылкой на источник.
