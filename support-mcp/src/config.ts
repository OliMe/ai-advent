/** Провайдер тикет-системы (пока только github; задел под gitlab/jira/zendesk/json). */
export type SupportProvider = 'github';

/** Конфигурация сервера поддержки: провайдер CRM + доступ + лимиты. */
export interface SupportConfig {
  provider: SupportProvider;
  /** База API: `https://api.github.com` или `https://ghe.corp/api/v3` (Enterprise). */
  apiBaseUrl: string;
  /** Репозиторий-трекер: `owner/name`. */
  repo: string;
  /** Токен доступа. */
  token: string;
  /** Потолок символов вывода инструмента (усечение помечается честно). */
  maxOutputChars: number;
  /** Таймаут запроса к API (мс). */
  timeoutMs: number;
  /** Число повторов при 429/5xx/сети. */
  maxRetries: number;
  /** База экспоненциальной паузы между повторами (мс). */
  retryBaseMs: number;
}

/** Положительное целое из строки в границах или значение по умолчанию. */
function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(Math.floor(value), min), max);
}

/**
 * Загружает конфигурацию из окружения. Репозиторий/токен нужны для обращения к API; база API
 * настраиваемая (GitHub Enterprise). `SUPPORT_*` приоритетнее общих `GITHUB_*`. Провайдер пока всегда
 * github (шов замены — в `createProvider`; `SUPPORT_PROVIDER` заработает, когда добавится второй).
 */
export function loadSupportConfig(env: NodeJS.ProcessEnv): SupportConfig {
  const apiBaseUrl = (
    env.SUPPORT_API_URL?.trim() ||
    env.GITHUB_API_URL?.trim() ||
    'https://api.github.com'
  ).replace(/\/+$/, '');
  return {
    provider: 'github',
    apiBaseUrl,
    repo: env.SUPPORT_REPO?.trim() || env.GITHUB_REPOSITORY?.trim() || '',
    token: env.SUPPORT_TOKEN?.trim() || env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim() || '',
    maxOutputChars: boundedInt(env.SUPPORT_MAX_OUTPUT_CHARS, 8000, 500, 200000),
    timeoutMs: boundedInt(env.SUPPORT_TIMEOUT_MS, 30000, 1000, 600000),
    maxRetries: boundedInt(env.SUPPORT_MAX_RETRIES, 3, 0, 10),
    retryBaseMs: boundedInt(env.SUPPORT_RETRY_BASE_MS, 500, 1, 60000),
  };
}
