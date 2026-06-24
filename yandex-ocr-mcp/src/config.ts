/** Конфигурация подключения к Yandex Vision OCR (из переменных окружения). */
export interface OcrConfig {
  /** Готовое значение заголовка Authorization: «Api-Key …» или «Bearer …». */
  authorization: string;
  /** Идентификатор каталога (заголовок x-folder-id); нужен с IAM-токеном. */
  folderId?: string;
  /** URL синхронного распознавания текста. */
  endpoint: string;
  /** Таймаут запроса, мс. */
  timeoutMs: number;
  /** Модель распознавания по умолчанию (page/handwritten/table/…). */
  model: string;
  /** Языки распознавания по умолчанию (например ["*"] или ["ru","en"]). */
  languageCodes: string[];
}

const DEFAULT_ENDPOINT = 'https://ocr.api.cloud.yandex.net/ocr/v1/recognizeText';
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MODEL = 'page';

/** Значение заголовка Authorization: приоритет у API-ключа, иначе IAM-токен; иначе ошибка. */
function resolveAuthorization(env: NodeJS.ProcessEnv): string {
  const apiKey = env.YANDEX_OCR_API_KEY?.trim();
  if (apiKey) {
    return `Api-Key ${apiKey}`;
  }
  const iamToken = env.YANDEX_IAM_TOKEN?.trim();
  if (iamToken) {
    return `Bearer ${iamToken}`;
  }
  throw new Error(
    'Не заданы креденшелы Yandex OCR: укажите YANDEX_OCR_API_KEY или YANDEX_IAM_TOKEN в .env.',
  );
}

/** Целое не меньше 1 из env или значение по умолчанию. */
function parsePositiveInteger(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 ? value : fallback;
}

/** Языки распознавания из env (через запятую); пусто — все языки ["*"]. */
function parseLanguageCodes(raw: string | undefined): string[] {
  const codes = (raw ?? '')
    .split(',')
    .map(code => code.trim())
    .filter(Boolean);
  return codes.length > 0 ? codes : ['*'];
}

/** Собирает конфигурацию Yandex OCR из переменных окружения. */
export function loadOcrConfig(env: NodeJS.ProcessEnv): OcrConfig {
  const folderId = env.YANDEX_FOLDER_ID?.trim();
  return {
    authorization: resolveAuthorization(env),
    endpoint: env.YANDEX_OCR_ENDPOINT?.trim() || DEFAULT_ENDPOINT,
    timeoutMs: parsePositiveInteger(env.YANDEX_OCR_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    model: env.YANDEX_OCR_MODEL?.trim() || DEFAULT_MODEL,
    languageCodes: parseLanguageCodes(env.YANDEX_OCR_LANGUAGES),
    ...(folderId ? { folderId } : {}),
  };
}
