/**
 * Распознавание речи через Yandex SpeechKit (STT v1, синхронный recognize). Нативный fetch,
 * без SDK. Конфиг — из окружения (та же схема авторизации, что у Yandex Vision OCR): Api-Key +
 * folderId. Используется голосовым вводом llm-cli: записанный звук (OggOpus) → текст.
 */

/** Конфиг распознавания речи. */
export interface VoiceConfig {
  /** Значение заголовка Authorization (например, «Api-Key <ключ>»). */
  authorization: string;
  /** Каталог Yandex Cloud (folderId); необязателен — API-ключ обычно выводит каталог сам. */
  folderId?: string;
  /** Язык распознавания (например, ru-RU). */
  lang: string;
}

/** Узкий контракт fetch для STT: тело — бинарный звук. Инжектируется для тестируемости. */
export type SpeechFetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: Uint8Array; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * Загружает конфиг распознавания речи из окружения. Возвращает null, если креды не заданы —
 * тогда голосовой ввод просто выключен (фича опциональна).
 */
export function loadVoiceConfig(env: NodeJS.ProcessEnv): VoiceConfig | null {
  const apiKey = env.YANDEX_API_KEY?.trim();
  if (!apiKey) {
    return null;
  }
  const folderId = env.YANDEX_FOLDER_ID?.trim();
  return {
    authorization: `Api-Key ${apiKey}`,
    lang: env.YANDEX_STT_LANG?.trim() || 'ru-RU',
    ...(folderId ? { folderId } : {}),
  };
}

/** Безопасно достаёт поле объекта (или undefined для не-объектов). */
function pick(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** Разбирает успешный ответ STT: распознанный текст из поля result. */
export function parseSpeechResponse(json: unknown): string {
  const result = pick(json, 'result');
  if (typeof result !== 'string' || result.trim() === '') {
    throw new Error('Yandex SpeechKit вернул пустой результат распознавания.');
  }
  return result.trim();
}

/** URL синхронного распознавания (OggOpus, заданный язык; folderId — если задан). */
function recognizeUrl(config: VoiceConfig): string {
  const params = new URLSearchParams({ topic: 'general', lang: config.lang, format: 'oggopus' });
  if (config.folderId) {
    params.set('folderId', config.folderId);
  }
  return `https://stt.api.cloud.yandex.net/speech/v1/stt:recognize?${params.toString()}`;
}

/** Распознаёт звук (OggOpus) в текст через Yandex SpeechKit. */
export async function transcribeWithYandex(
  fetchFn: SpeechFetchLike,
  config: VoiceConfig,
  audio: Uint8Array,
  requestTimeoutMs: number,
): Promise<string> {
  const response = await fetchFn(recognizeUrl(config), {
    method: 'POST',
    headers: { Authorization: config.authorization },
    body: audio,
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Yandex SpeechKit вернул ошибку HTTP ${response.status}.`);
  }
  return parseSpeechResponse(await response.json());
}
