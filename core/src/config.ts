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
  };
}
