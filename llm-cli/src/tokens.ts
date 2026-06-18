import type { AppConfig, ChatMessage, Usage } from '../../core/src/index.ts';

/** Сколько символов считаем за один токен в грубой оценке (провайдер-агностично). */
export const CHARS_PER_TOKEN = 3;
/** Накладные токены на одно сообщение (роль и служебная разметка). */
const MESSAGE_OVERHEAD_TOKENS = 4;
/** Сколько токенов резервируем под ответ, если --max-tokens не задан. */
const DEFAULT_RESPONSE_RESERVE_TOKENS = 1024;
/** Нижняя граница бюджета истории, чтобы он не оказался нулём/отрицательным. */
export const MIN_HISTORY_BUDGET_TOKENS = 256;

/**
 * Грубая оценка числа токенов в тексте. Точного токенизатора нет (приложение
 * провайдер-агностично), поэтому считаем консервативно — лучше переоценить
 * размер и обрезать чуть больше, чем переполнить контекст модели.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Обрезает текст до бюджета токенов (грубо, по символам), добавляя многоточие. */
export function capToBudget(text: string, budgetTokens: number): string {
  if (estimateTokens(text) <= budgetTokens) {
    return text;
  }
  return text.slice(0, Math.max(0, budgetTokens * CHARS_PER_TOKEN - 1)) + '…';
}

/** Оценка токенов одного сообщения: содержимое плюс накладные расходы. */
function messageTokens(message: ChatMessage): number {
  return estimateTokens(message.content) + MESSAGE_OVERHEAD_TOKENS;
}

/** Приблизительный размер всей истории сессии в токенах. */
export function historyTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + messageTokens(message), 0);
}

/** Стоимость запроса в долларах по тарифам конфига ($/1M токенов). */
export function requestCostUsd(usage: Usage, config: AppConfig): number {
  return (
    (usage.prompt_tokens * config.priceInputPer1M +
      usage.completion_tokens * config.priceOutputPer1M) /
    1_000_000
  );
}

/**
 * Строка статистики под ответом: токены входа/выхода запроса, размер истории
 * сессии и стоимость в $ и ₽. Если usage не пришёл — «н/д»; если тарифы не
 * заданы — подсказка задать LLM_PRICE_*.
 */
export function formatUsageStats(
  usage: Usage | undefined,
  historyTokenCount: number,
  config: AppConfig,
  label?: string,
): string {
  const prefix = label ? `${label} · ` : '';
  if (usage === undefined) {
    return `[${prefix}токены: н/д · история ~${historyTokenCount}]`;
  }
  const hasPricing = config.priceInputPer1M > 0 || config.priceOutputPer1M > 0;
  const usd = requestCostUsd(usage, config);
  const cost = hasPricing
    ? ` · ≈ $${usd.toFixed(6)} / ${(usd * config.usdToRub).toFixed(4)} ₽`
    : ' · цена: задайте LLM_PRICE_INPUT_PER_1M / LLM_PRICE_OUTPUT_PER_1M';
  return (
    `[${prefix}вход ${usage.prompt_tokens} · выход ${usage.completion_tokens} · ` +
    `история ~${historyTokenCount}${cost}]`
  );
}

/** Итоговая сводка за сессию: суммарные токены и стоимость в $ и ₽. */
export function formatSessionTotals(totals: Usage, config: AppConfig): string {
  const hasPricing = config.priceInputPer1M > 0 || config.priceOutputPer1M > 0;
  const usd = requestCostUsd(totals, config);
  const cost = hasPricing
    ? ` · ≈ $${usd.toFixed(6)} / ${(usd * config.usdToRub).toFixed(4)} ₽`
    : '';
  return (
    `Итого за сессию: вход ${totals.prompt_tokens} · выход ${totals.completion_tokens} · ` +
    `всего ${totals.total_tokens}${cost}`
  );
}

/**
 * Бюджет истории в токенах: контекст модели за вычетом резерва под ответ
 * (явный --max-tokens или дефолтный резерв), но не ниже минимума.
 */
export function historyBudgetTokens(contextTokens: number, maxTokens?: number): number {
  const responseReserve = maxTokens ?? DEFAULT_RESPONSE_RESERVE_TOKENS;
  return Math.max(contextTokens - responseReserve, MIN_HISTORY_BUDGET_TOKENS);
}

/**
 * Скользящее окно истории по токенам: всегда сохраняет системные сообщения и
 * оставляет самые свежие реплики, пока укладывается в бюджет. Самое последнее
 * сообщение сохраняется всегда — даже если оно одно превышает бюджет.
 */
export function trimHistoryToBudget(history: ChatMessage[], budgetTokens: number): ChatMessage[] {
  const systemMessages = history.filter(message => message.role === 'system');
  const conversation = history.filter(message => message.role !== 'system');

  let usedTokens = systemMessages.reduce((sum, message) => sum + messageTokens(message), 0);
  const keptInReverse: ChatMessage[] = [];
  for (let index = conversation.length - 1; index >= 0; index--) {
    const cost = messageTokens(conversation[index]);
    if (keptInReverse.length > 0 && usedTokens + cost > budgetTokens) {
      break;
    }
    keptInReverse.push(conversation[index]);
    usedTokens += cost;
  }
  keptInReverse.reverse();
  return [...systemMessages, ...keptInReverse];
}
