import { join } from 'node:path';

/** Конфигурация ассистента поддержки: доступ к трекеру + событие + корпус FAQ + кэш. */
export interface SupportBotConfig {
  /** Репозиторий-трекер `owner/name`. */
  repo: string;
  /** Токен доступа к трекеру. */
  token: string;
  /** База API трекера (настраиваемая — Enterprise/self-hosted). */
  apiBaseUrl: string;
  /** Номер тикета, на который отвечаем; 0 — не задан. */
  issueNumber: number;
  /** Имя события CI (`issues`/`issue_comment`) — влияет на выбор источника вопроса. */
  event: string;
  /** Инициатор события (логин) — для наблюдаемости. */
  actor: string;
  /** Каталог с markdown-файлами FAQ. */
  faqDir: string;
  /** Каталог кэша индекса FAQ. */
  cacheDir: string;
  /** Сколько фрагментов FAQ подмешивать. */
  topKFaq: number;
  /** Гасить рассуждения модели (нужно GLM). */
  disableThinking: boolean;
  /**
   * Поиск по КОДУ репозитория (тумблер `SUPPORT_CODE_SEARCH=1`). Выкл по умолчанию: поддержка
   * пользователей отвечает по FAQ, а код нужен лишь для технических issues от разработчиков. Вкл →
   * бот подключает git-mcp и добавляет фрагменты кода в доказательства (тот же цитатный гейт).
   */
  codeSearch: boolean;
  /** Git-ref для ссылок на файлы FAQ (SHA-перманентная ссылка или ветка). */
  ref: string;
  /** Корень репозитория — путь файла FAQ в ссылке считается относительно него; пусто → без ссылок. */
  repoRoot: string;
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
 * Загружает конфигурацию из окружения. Пути FAQ/кэша по умолчанию — относительно каталога пакета
 * (`packageDir`). `SUPPORT_*` приоритетнее общих `GITHUB_*`; база API настраиваемая (Enterprise).
 */
export function loadSupportBotConfig(env: NodeJS.ProcessEnv, packageDir: string): SupportBotConfig {
  const apiBaseUrl = (
    env.SUPPORT_API_URL?.trim() ||
    env.GITHUB_API_URL?.trim() ||
    'https://api.github.com'
  ).replace(/\/+$/, '');
  return {
    repo: env.SUPPORT_REPO?.trim() || env.GITHUB_REPOSITORY?.trim() || '',
    token: env.SUPPORT_TOKEN?.trim() || env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim() || '',
    apiBaseUrl,
    issueNumber: boundedInt(env.SUPPORT_ISSUE_NUMBER, 0, 0, Number.MAX_SAFE_INTEGER),
    event: env.SUPPORT_EVENT?.trim() || '',
    actor: env.SUPPORT_ACTOR?.trim() || '',
    faqDir: env.SUPPORT_FAQ_DIR?.trim() || join(packageDir, 'faq'),
    cacheDir: env.SUPPORT_CACHE_DIR?.trim() || join(packageDir, '.support-bot-cache'),
    topKFaq: boundedInt(env.SUPPORT_TOP_K_FAQ, 5, 0, 50),
    disableThinking: env.SUPPORT_NO_THINKING === '1',
    codeSearch: env.SUPPORT_CODE_SEARCH === '1',
    // GITHUB_SHA/GITHUB_WORKSPACE — штатные переменные Actions (перманентная ссылка + корень репо).
    ref: env.SUPPORT_REF?.trim() || env.GITHUB_SHA?.trim() || 'main',
    repoRoot: env.SUPPORT_REPO_ROOT?.trim() || env.GITHUB_WORKSPACE?.trim() || '',
  };
}
