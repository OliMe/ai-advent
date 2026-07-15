import { SEVERITY_ORDER } from './schema.ts';
import type { FindingSeverity } from './schema.ts';

/** Платформа хостинга репозитория. */
export type Platform = 'github' | 'gitlab';

/** Конфигурация ревью: платформа/доступ + параметры генерации. */
export interface ReviewConfig {
  platform: Platform;
  /** База API (настраиваемая — для GitHub Enterprise / корпоративного GitLab). */
  apiBaseUrl: string;
  /** Токен доступа; пустой — только локальный `--diff`/`--dry-run` без обращения к API. */
  token: string;
  /** Репозиторий: `owner/name` (GitHub) или id/путь проекта (GitLab). */
  repo: string;
  /** Номер PR/MR; 0 — не задан (локальный режим). */
  prNumber: number;
  /** Путь к рабочему дереву репозитория (доки + содержимое файлов). */
  workingDir: string;
  /** Потолок токенов ответа модели. */
  maxTokens: number;
  /** Температура генерации ревью (низкая — ответ по фактам). */
  temperature: number;
  /** Сколько фрагментов документации подмешивать. */
  topKDocs: number;
  /** Гасить рассуждения модели (нужно GLM). */
  disableThinking: boolean;
  /** Минимальная категория для ИНЛАЙН-комментария; менее серьёзные уходят в сводку. */
  minSeverity: FindingSeverity;
  /** Потолок числа инлайн-комментариев на PR; сверх — в сводку. */
  maxInline: number;
}

/** Положительное целое из строки в границах или значение по умолчанию. */
function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(Math.floor(value), min), max);
}

/** Неотрицательная температура из строки или дефолт. */
function parseTemperature(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Платформа из строки; неизвестное/пусто → github. */
export function parsePlatform(raw: string | undefined): Platform {
  return raw?.trim().toLowerCase() === 'gitlab' ? 'gitlab' : 'github';
}

/** Категория из строки; неизвестное/пусто → `nitpick` (порог не режет — инлайн всё). */
export function parseMinSeverity(raw: string | undefined): FindingSeverity {
  const value = raw?.trim().toLowerCase();
  return SEVERITY_ORDER.find(severity => severity === value) ?? 'nitpick';
}

/** База API по умолчанию для платформы. */
function defaultApiBaseUrl(platform: Platform): string {
  return platform === 'gitlab' ? 'https://gitlab.com/api/v4' : 'https://api.github.com';
}

/**
 * Загружает конфигурацию ревью из окружения. Токен/репозиторий/номер PR нужны только для обращения к
 * API — в локальном режиме (`--diff` + `--dry-run`) их можно не задавать. LLM-настройки (модель, ключ,
 * контекст, structuredOutputs) берутся отдельно через `core.loadConfig`.
 */
export function loadReviewConfig(env: NodeJS.ProcessEnv, workingDirectory: string): ReviewConfig {
  const platform = parsePlatform(env.PR_REVIEW_PLATFORM);
  const apiBaseUrl = (
    env.PR_REVIEW_API_URL?.trim() ||
    env.GITHUB_API_URL?.trim() ||
    env.CI_API_V4_URL?.trim() ||
    defaultApiBaseUrl(platform)
  ).replace(/\/+$/, '');
  return {
    platform,
    apiBaseUrl,
    token: env.PR_REVIEW_TOKEN?.trim() || env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim() || '',
    repo: env.PR_REVIEW_REPO?.trim() || env.GITHUB_REPOSITORY?.trim() || '',
    prNumber: boundedInt(env.PR_REVIEW_PR_NUMBER, 0, 0, Number.MAX_SAFE_INTEGER),
    workingDir: env.PR_REVIEW_WORKDIR?.trim() || workingDirectory,
    maxTokens: boundedInt(env.PR_REVIEW_MAX_TOKENS, 2048, 256, 32000),
    temperature: parseTemperature(env.PR_REVIEW_TEMPERATURE, 0.2),
    topKDocs: boundedInt(env.PR_REVIEW_TOP_K_DOCS, 5, 0, 50),
    disableThinking: env.PR_REVIEW_NO_THINKING === '1',
    minSeverity: parseMinSeverity(env.PR_REVIEW_MIN_SEVERITY),
    maxInline: boundedInt(env.PR_REVIEW_MAX_INLINE, 20, 1, 200),
  };
}
