/** Конфигурация приложения, собранная из переменных окружения. */
export interface AppConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
  systemPrompt: string;
  requestTimeoutMs: number;
  /** Размер контекстного окна выбранной модели в токенах (для обрезки истории). */
  contextTokens: number;
  /** Сколько раз повторять запрос при 429/5xx/сетевых сбоях (0 — без повторов). */
  maxRetries: number;
  /** Базовая задержка экспоненциального бэкоффа между повторами, мс. */
  retryBaseMs: number;
  /** Цена входных токенов, $ за 1M (0 — тариф не задан, стоимость не считаем). */
  priceInputPer1M: number;
  /** Цена выходных токенов, $ за 1M (0 — тариф не задан). */
  priceOutputPer1M: number;
  /** Курс доллара к рублю для вывода стоимости в ₽. */
  usdToRub: number;
  /**
   * Потолок генерации для агентов пайплайна задач (этапы + аналитик), токенов.
   * Не задан — берётся дефолт провайдера. Нужен провайдерам, требующим явный
   * max_tokens (иначе подставляют 0 и отвергают запрос).
   */
  stageMaxTokens?: number;
  /**
   * Потолок числа агентов на этап (команда ролей). 1 — многоагентность выключена
   * (оркестратор не вызывается, поведение однопроходное). По умолчанию 4.
   */
  maxStageAgents: number;
  /** Максимум одновременных запросов роль-агентов внутри этапа. По умолчанию 2. */
  stageAgentConcurrency: number;
  /**
   * Максимум раундов «модель ↔ инструменты» за один ход чата с MCP-инструментами. Раунд —
   * один ответ модели (может содержать пачку вызовов); зависимые шаги длинного флоу идут
   * отдельными раундами. По умолчанию 12 (хватает на длинные кросс-серверные сценарии).
   */
  maxToolRounds: number;
  /**
   * Структурированный вывод этапов пайплайна (constrained decoding по JSON-схеме).
   * Включается ЯВНО (`LLM_STRUCTURED_OUTPUTS=1`) под модель, которая это умеет (Ollama);
   * провайдера не детектим. По умолчанию выключен: `response_format` ломает z.ai/GLM,
   * поэтому дефолтный путь остаётся прежним — JSON просим в промпте.
   */
  structuredOutputs: boolean;
  /**
   * Модель роли ВЫПОЛНЕНИЯ пайплайна (`LLM_EXECUTOR_MODEL`) — напр. специализированная
   * code-модель. Не задана — этап выполнения идёт на общую `LLM_MODEL`, как остальные роли.
   * Смена модели за роль стоит переключения в Ollama, если модели не помещаются в память вместе.
   */
  executorModel?: string;
  /**
   * Имена `.env`-файлов проекта, подмешиваемых в команды пайплайна (`LLM_PROJECT_ENV_FILES`, через
   * запятую; позже в списке — выше приоритет). Не задан — общий dev-набор (`.env`/`.env.development`/
   * `.env.dev`/`.env.local`/…). Для проектов с нестандартным именем dev-файла окружения.
   */
  projectEnvFiles?: string[];
}

const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_SYSTEM_PROMPT = 'Ты — полезный ассистент. Отвечай ясно и по делу на русском языке.';
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_MS = 500;
const DEFAULT_CONTEXT_TOKENS = 8192;
const DEFAULT_PRICE_PER_1M = 0;
const DEFAULT_USD_RUB = 90;
const DEFAULT_MAX_STAGE_AGENTS = 4;
const DEFAULT_STAGE_AGENT_CONCURRENCY = 2;
const DEFAULT_MAX_TOOL_ROUNDS = 20;

/** Конечное неотрицательное число из env или значение по умолчанию. */
function nonNegativeNumber(raw: string | undefined, fallback: number): number {
  const value = Number(raw ?? fallback);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Целое не меньше 1 из env или значение по умолчанию (для счётчиков агентов). */
function positiveInteger(raw: string | undefined, fallback: number): number {
  const value = Number(raw ?? fallback);
  return Number.isInteger(value) && value >= 1 ? value : fallback;
}

/**
 * Подгружает переменные из файла .env в process.env, если файл существует.
 * Уже заданные в окружении переменные имеют приоритет и не перезаписываются.
 */
function loadDotEnv(): void {
  try {
    process.loadEnvFile();
  } catch {
    // Файла .env нет — это нормально, используем чистое окружение.
  }
}

/** Возвращает значение обязательной переменной окружения или бросает понятную ошибку. */
function requireEnvironmentVariable(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `Не задана обязательная переменная окружения ${name}.\n` +
        'Укажите её в .env или в окружении (пример см. в .env.example).',
    );
  }
  return value;
}

/**
 * Считывает и валидирует конфигурацию из переменных окружения.
 * Привязки к конкретному провайдеру нет: подойдёт любой OpenAI-совместимый
 * эндпоинт chat/completions — достаточно задать URL, модель и ключ.
 */
export function loadConfig(): AppConfig {
  loadDotEnv();

  const apiKey = requireEnvironmentVariable('LLM_API_KEY');
  const baseUrl = requireEnvironmentVariable('LLM_BASE_URL');
  const model = requireEnvironmentVariable('LLM_MODEL');

  const temperature = Number(process.env.LLM_TEMPERATURE ?? DEFAULT_TEMPERATURE);
  const requestTimeoutMs = Number(process.env.LLM_REQUEST_TIMEOUT_MS ?? DEFAULT_REQUEST_TIMEOUT_MS);
  const maxRetries = Number(process.env.LLM_MAX_RETRIES ?? DEFAULT_MAX_RETRIES);
  const retryBaseMs = Number(process.env.LLM_RETRY_BASE_MS ?? DEFAULT_RETRY_BASE_MS);
  const contextTokens = Number(process.env.LLM_CONTEXT_TOKENS ?? DEFAULT_CONTEXT_TOKENS);
  const usdToRub = Number(process.env.LLM_USD_RUB ?? DEFAULT_USD_RUB);
  // Потолок генерации этапов — положительное целое; иначе не задаём (дефолт провайдера).
  const stageMaxTokens = Number(process.env.LLM_STAGE_MAX_TOKENS);

  return {
    apiKey,
    baseUrl,
    model,
    temperature: Number.isFinite(temperature) ? temperature : DEFAULT_TEMPERATURE,
    systemPrompt: process.env.LLM_SYSTEM_PROMPT?.trim() || DEFAULT_SYSTEM_PROMPT,
    // Таймаут должен быть положительным; иначе откатываемся к значению по умолчанию.
    requestTimeoutMs:
      Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0
        ? requestTimeoutMs
        : DEFAULT_REQUEST_TIMEOUT_MS,
    // Число повторов — неотрицательное целое; иначе значение по умолчанию.
    maxRetries: Number.isInteger(maxRetries) && maxRetries >= 0 ? maxRetries : DEFAULT_MAX_RETRIES,
    // Базовая задержка — положительная; иначе значение по умолчанию.
    retryBaseMs:
      Number.isFinite(retryBaseMs) && retryBaseMs > 0 ? retryBaseMs : DEFAULT_RETRY_BASE_MS,
    // Размер контекста — положительное целое; иначе значение по умолчанию.
    contextTokens:
      Number.isInteger(contextTokens) && contextTokens > 0 ? contextTokens : DEFAULT_CONTEXT_TOKENS,
    // Тарифы — неотрицательные числа ($/1M); 0 означает «тариф не задан».
    priceInputPer1M: nonNegativeNumber(process.env.LLM_PRICE_INPUT_PER_1M, DEFAULT_PRICE_PER_1M),
    priceOutputPer1M: nonNegativeNumber(process.env.LLM_PRICE_OUTPUT_PER_1M, DEFAULT_PRICE_PER_1M),
    // Курс ₽/$ — положительный; иначе значение по умолчанию.
    usdToRub: Number.isFinite(usdToRub) && usdToRub > 0 ? usdToRub : DEFAULT_USD_RUB,
    // Потолок генерации этапов задаётся только если это положительное целое.
    ...(Number.isInteger(stageMaxTokens) && stageMaxTokens > 0 ? { stageMaxTokens } : {}),
    // Команда агентов на этап: потолок ролей и конкурентность веера запросов.
    maxStageAgents: positiveInteger(process.env.LLM_MAX_STAGE_AGENTS, DEFAULT_MAX_STAGE_AGENTS),
    stageAgentConcurrency: positiveInteger(
      process.env.LLM_STAGE_AGENT_CONCURRENCY,
      DEFAULT_STAGE_AGENT_CONCURRENCY,
    ),
    // Потолок раундов агентного цикла чата с инструментами (длинный кросс-серверный флоу).
    maxToolRounds: positiveInteger(process.env.LLM_MAX_TOOL_ROUNDS, DEFAULT_MAX_TOOL_ROUNDS),
    // Тумблер constrained decoding: только явное «1» включает схемы этапов.
    structuredOutputs: process.env.LLM_STRUCTURED_OUTPUTS === '1',
    // Модель роли выполнения; задаётся только непустой строкой, иначе не задаём (фолбэк на LLM_MODEL).
    ...(process.env.LLM_EXECUTOR_MODEL?.trim()
      ? { executorModel: process.env.LLM_EXECUTOR_MODEL.trim() }
      : {}),
    // Оверрайд имён .env-файлов проекта; задан непустым списком — иначе общий dev-набор по умолчанию.
    ...(() => {
      const files = (process.env.LLM_PROJECT_ENV_FILES ?? '')
        .split(',')
        .map(name => name.trim())
        .filter(name => name.length > 0);
      return files.length > 0 ? { projectEnvFiles: files } : {};
    })(),
  };
}

/**
 * Конфигурация клиента эмбеддингов (OpenAI-совместимый `/embeddings`). Провайдеро-независима:
 * URL/модель/ключ задаются окружением, поэтому Ollama (локально, без ключа) меняется на любой
 * удалённый сервис правкой `.env` без изменений кода.
 */
export interface EmbeddingsConfig {
  /** URL эндпоинта эмбеддингов (например, http://localhost:11434/v1/embeddings). */
  url: string;
  /** Имя модели эмбеддингов (например, nomic-embed-text). */
  model: string;
  /** Ключ доступа; не задан — заголовок Authorization не шлётся (Ollama его не требует). */
  apiKey?: string;
  /** Таймаут запроса, мс. */
  requestTimeoutMs: number;
  /** Число повторов при 429/5xx/сетевых сбоях. */
  maxRetries: number;
  /** Базовая задержка экспоненциального бэкоффа между повторами, мс. */
  retryBaseMs: number;
}

/**
 * Собирает конфигурацию эмбеддингов из окружения. URL и модель обязательны (без них индексация
 * невозможна). Таймаут/повторы переиспользуют те же переменные, что и чат-клиент.
 */
export function loadEmbeddingsConfig(env: NodeJS.ProcessEnv): EmbeddingsConfig {
  const url = env.LLM_EMBEDDINGS_URL?.trim();
  if (!url) {
    throw new Error('Не задана LLM_EMBEDDINGS_URL (эндпоинт /embeddings) — укажите в .env.');
  }
  const model = env.LLM_EMBEDDINGS_MODEL?.trim();
  if (!model) {
    throw new Error('Не задана LLM_EMBEDDINGS_MODEL (модель эмбеддингов) — укажите в .env.');
  }
  const apiKey = env.LLM_EMBEDDINGS_API_KEY?.trim();
  const retries = Number(env.LLM_MAX_RETRIES ?? DEFAULT_MAX_RETRIES);
  return {
    url,
    model,
    ...(apiKey ? { apiKey } : {}),
    requestTimeoutMs: positiveInteger(env.LLM_REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS),
    maxRetries: Number.isInteger(retries) && retries >= 0 ? retries : DEFAULT_MAX_RETRIES,
    retryBaseMs: positiveInteger(env.LLM_RETRY_BASE_MS, DEFAULT_RETRY_BASE_MS),
  };
}
