# Локальная LLM (Ollama) — День 26

Как поднять локальную LLM, обратиться к ней тремя способами (CLI / HTTP / наш `llm-cli`)
и прогнать запросы разной сложности. Всё выполняется на машине, без облака и ключей.

## Окружение

- **Железо:** Apple M2, 16 ГБ RAM, macOS 14.6. Комфортно тянет модели до ~7–8B в 4-битной
  квантовке.
- **Рантайм:** [Ollama](https://ollama.com) — уже используется проектом для эмбеддингов RAG
  (`nomic-embed-text` на `localhost:11434`). Даёт CLI (`ollama run`) и HTTP: нативный
  `/api/generate` **и** OpenAI-совместимый `/v1/chat/completions`.
- **Модели** (скачаны `ollama pull`):
  | Модель | Размер | Роль |
  | ------ | ------ | ---- |
  | `qwen2.5:7b` | 4.7 ГБ | качество (код/рассуждения) |
  | `llama3.2:3b` | 2.0 ГБ | скорость (лёгкая) |

## Запуск

```bash
ollama serve                 # поднять сервер (обычно уже запущен как сервис — тогда «address already in use», это норма)
ollama pull qwen2.5:7b       # ~4.7 ГБ
ollama pull llama3.2:3b      # ~2.0 ГБ
ollama list                  # проверить, что модели на месте
curl -s http://localhost:11434/api/tags   # HTTP жив
```

## Три способа обращения

### 1. CLI

```bash
ollama run qwen2.5:7b "Столица Австралии? Ответь одним словом."
# → Канберра
```

### 2. HTTP — нативный `/api/generate`

```bash
curl -s http://localhost:11434/api/generate -d '{
  "model": "qwen2.5:7b",
  "prompt": "Столица Австралии? Ответь одним словом.",
  "stream": false
}'
# → {"response":"Канберра", ..., "total_duration": ...}
```

### 3. HTTP — OpenAI-совместимый `/v1/chat/completions`

```bash
curl -s http://localhost:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ollama" \
  -d '{"model":"qwen2.5:7b","messages":[{"role":"user","content":"Ответь одним словом: столица Японии?"}]}'
# → choices[0].message.content = "Токио"  (+ usage: prompt/completion tokens)
```

`Authorization: Bearer ollama` — заглушка: Ollama ключ не проверяет, но OpenAI-клиенты
требуют заголовок.

## Догфуд: наш `llm-cli` → локальная модель

`llm-cli` — OpenAI-совместимый клиент, поэтому нацеливается на Ollama **только через
переменные окружения**, без единой правки кода. Свой рабочий `.env` (z.ai/DeepSeek) не
трогаем — задаём переменные inline:

```bash
cd llm-cli
LLM_API_KEY=ollama \
LLM_BASE_URL=http://localhost:11434/v1/chat/completions \
LLM_MODEL=qwen2.5:7b \
LLM_CONTEXT_TOKENS=32768 \
node src/cli.ts --no-thinking "Столица Австралии? Ответь одним словом."
# → Канберра
```

(Альтернатива — прописать эти же `LLM_*` в `llm-cli/.env`; принципиально ничего не
меняется, но inline не перетирает основной конфиг.)

## Запросы разной сложности (проверка)

Прогнано на обеих моделях (HTTP OpenAI-совместимый). Результаты — «как есть»,
включая огрехи маленькой модели.

### (a) Простой факт — «Столица Австралии?»

| Модель | Ответ | Время |
| ------ | ----- | ----- |
| `qwen2.5:7b` | Канберра | ~1.6 c |
| `llama3.2:3b` | Канбера. *(опечатка)* | ~4.2 c |

### (b) Рассуждение/логика

**qwen2.5:7b** («Аня, 3 брата и 2 сестры — сколько сестёр у брата Пети?» через `llm-cli`):
верно — «2 сестры» (Аня + её сестра).

На задачке-подвохе про гусей («один впереди двух, один позади двух, один между двумя —
наименьшее число?») правильный ответ — **3** (гуси идут гуськом: 1-2-3). Тут вышло
показательно: **llama3.2:3b выдала верное «3»** (быстро, но с корявым обоснованием и
случайным испанским словом), а **qwen2.5:7b запуталась и назвала 5** — маленькая модель
«угадала» лучше. Локальные модели ошибаются на подвохах — это ожидаемо.

### (c) Генерация кода — обобщённый `debounce` на TypeScript

**qwen2.5:7b** — чистый корректный вариант с дженериком по кортежу аргументов:

```typescript
type DebounceCallback<T extends any[]> = (...args: T) => void;

function debounce<T extends any[]>(callback: DebounceCallback<T>, delay: number): DebounceCallback<T> {
  let timeoutId: NodeJS.Timeout | null = null;
  return function (...args: T) {
    if (timeoutId !== null) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => { callback(...args); timeoutId = null; }, delay);
  };
}
```

**llama3.2:3b** — проще и с изъяном (`return debouncedFn` при возвращаемом типе `void`);
для 3B ожидаемо слабее.

## Вывод

Локальная LLM запущена и отвечает: модель работает **локально**, доступна через **CLI и
два HTTP-API**, отвечает на запросы **разной сложности**, и с ней штатно работает наш
`llm-cli`. `qwen2.5:7b` заметно сильнее на коде и фактах; `llama3.2:3b` быстрее и легче,
качество ниже — разумный выбор «скорость против качества» под 16 ГБ RAM.
