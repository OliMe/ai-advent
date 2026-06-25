/** Настройка доставки в Telegram (Bot API). */
export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

/** HTTP-клиент для Telegram (шов для тестов). */
export type TelegramFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number }>;

/** Результат попытки доставки. */
export interface DeliveryResult {
  delivered: boolean;
  error?: string;
}

/** Текст ошибки из неизвестного значения. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Читает настройку Telegram из окружения. Оба значения заданы → конфиг; иначе undefined
 * (доставка в Telegram выключена, результаты только в инбоксе).
 */
export function loadTelegramConfig(env: NodeJS.ProcessEnv): TelegramConfig | undefined {
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_CHAT_ID?.trim();
  return botToken && chatId ? { botToken, chatId } : undefined;
}

/** Отправляет сообщение в Telegram; best-effort (ошибку возвращает, не бросает). */
export async function sendTelegramMessage(
  config: TelegramConfig,
  text: string,
  fetchFn: TelegramFetch,
): Promise<DeliveryResult> {
  try {
    const response = await fetchFn(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: config.chatId, text }),
    });
    return response.ok
      ? { delivered: true }
      : { delivered: false, error: `HTTP ${response.status}` };
  } catch (error) {
    return { delivered: false, error: errorMessage(error) };
  }
}
