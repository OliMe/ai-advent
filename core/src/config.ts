/** Конфигурация приложения, собранная из переменных окружения. */
export interface AppConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
  systemPrompt: string;
  requestTimeoutMs: number;
  /** Сколько раз повторять запрос при 429/5xx/сетевых сбоях (0 — без повторов). */
  maxRetries: number;
  /** Базовая задержка экспоненциального бэкоффа между повторами, мс. */
  retryBaseMs: number;
}

const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_SYSTEM_PROMPT = 'Ты — полезный ассистент. Отвечай ясно и по делу на русском языке.';
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_MS = 500;

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
  };
}
