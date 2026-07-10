/** Конфигурация шлюза, собранная из переменных окружения. */
export interface GatewayConfig {
  /** Порт, на котором шлюз слушает HTTP (за реверс-прокси, только localhost). */
  port: number;
  /** Разрешённые bearer-токены. Пустой список — авторизация выключена. */
  bearerTokens: string[];
  /** Ёмкость ведра токенов: столько запросов можно сделать «залпом». */
  rateLimitCapacity: number;
  /** Скорость пополнения ведра, запросов в минуту. */
  rateLimitRefillPerMinute: number;
  /** Потолок размера запроса в токенах (защита от долгой обработки промпта). */
  maxPromptTokens: number;
  /** Максимум запросов в очереди (включая исполняемый). Сверх — отказ 429. */
  maxQueueDepth: number;
  /** Сколько ядер отдано модели (CPUQuota) — для честного ценника в CPU-секундах. */
  quotaCores: number;
  /** Адрес OpenAI-совместимого эндпоинта локальной Ollama. */
  upstreamBaseUrl: string;
  /** Таймаут одного запроса к модели, мс. */
  requestTimeoutMs: number;
  /**
   * Префикс пути, под которым сервис виден снаружи (например, `/ai` за Caddy).
   * Реверс-прокси срезает его до шлюза, поэтому нужен только для ссылок в разметке.
   */
  basePath: string;
}

/** Значения по умолчанию: подобраны под замеры на 4-ядерном VPS с 3B-моделью. */
const DEFAULT_PORT = 3002;
const DEFAULT_RATE_LIMIT_CAPACITY = 10;
const DEFAULT_RATE_LIMIT_REFILL_PER_MINUTE = 10;
const DEFAULT_MAX_PROMPT_TOKENS = 1500;
const DEFAULT_MAX_QUEUE_DEPTH = 4;
const DEFAULT_QUOTA_CORES = 3;
const DEFAULT_UPSTREAM_BASE_URL = 'http://127.0.0.1:11434/v1/chat/completions';
const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;

/**
 * Читает положительное целое из переменной окружения. Не задано, не число или
 * не больше нуля — берётся значение по умолчанию.
 */
export function readPositiveInteger(raw: string | undefined, fallback: number): number {
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

/**
 * Разбирает список bearer-токенов из строки через запятую. Пустые элементы
 * отбрасываются; пустой результат означает выключенную авторизацию.
 */
export function readBearerTokens(raw: string | undefined): string[] {
  if (raw === undefined) {
    return [];
  }
  return raw
    .split(',')
    .map(token => token.trim())
    .filter(token => token.length > 0);
}

/** Нормализует префикс пути: без хвостового слэша, с ведущим. Пусто — корень. */
export function readBasePath(raw: string | undefined): string {
  const trimmed = raw?.trim().replace(/\/+$/, '');
  if (trimmed === undefined || trimmed === '') {
    return '';
  }
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

/** Собирает конфигурацию шлюза из окружения. */
export function loadGatewayConfig(env: NodeJS.ProcessEnv): GatewayConfig {
  const upstreamBaseUrl = env.GATEWAY_UPSTREAM_URL?.trim();
  return {
    port: readPositiveInteger(env.GATEWAY_PORT, DEFAULT_PORT),
    bearerTokens: readBearerTokens(env.GATEWAY_TOKENS),
    rateLimitCapacity: readPositiveInteger(env.GATEWAY_RATE_CAPACITY, DEFAULT_RATE_LIMIT_CAPACITY),
    rateLimitRefillPerMinute: readPositiveInteger(
      env.GATEWAY_RATE_REFILL_PER_MINUTE,
      DEFAULT_RATE_LIMIT_REFILL_PER_MINUTE,
    ),
    maxPromptTokens: readPositiveInteger(env.GATEWAY_MAX_PROMPT_TOKENS, DEFAULT_MAX_PROMPT_TOKENS),
    maxQueueDepth: readPositiveInteger(env.GATEWAY_MAX_QUEUE, DEFAULT_MAX_QUEUE_DEPTH),
    quotaCores: readPositiveInteger(env.GATEWAY_QUOTA_CORES, DEFAULT_QUOTA_CORES),
    upstreamBaseUrl: upstreamBaseUrl ? upstreamBaseUrl : DEFAULT_UPSTREAM_BASE_URL,
    requestTimeoutMs: readPositiveInteger(env.GATEWAY_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS),
    basePath: readBasePath(env.GATEWAY_BASE_PATH),
  };
}
