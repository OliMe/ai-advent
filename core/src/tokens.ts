import type { AppConfig } from './config.ts';
import type { ChatMessage, Usage } from './types.ts';

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
 * заданы — подсказка задать LLM_PRICE_*. Если задано время ответа (`elapsedMs`) и
 * есть токены выхода — добавляет скорость генерации (секунды + токены/сек), чтобы
 * скорость модели была видна пользователю (сравнение квантов/параметров вручную).
 */
export function formatUsageStats(
  usage: Usage | undefined,
  historyTokenCount: number,
  config: AppConfig,
  label?: string,
  elapsedMs?: number,
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
  // Скорость показываем только когда есть и время (>0), и токены выхода.
  const speed =
    elapsedMs !== undefined && elapsedMs > 0 && usage.completion_tokens > 0
      ? ` · ${(elapsedMs / 1000).toFixed(1)}с · ${(
          usage.completion_tokens /
          (elapsedMs / 1000)
        ).toFixed(0)} ток/с`
      : '';
  return (
    `[${prefix}вход ${usage.prompt_tokens} · выход ${usage.completion_tokens} · ` +
    `история ~${historyTokenCount}${speed}${cost}]`
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

/** Порог символов tool-результата, ниже которого offload не делаем (плейсхолдер был бы не короче). */
const OFFLOAD_MIN_CHARS = 200;
/** Сколько последних tool-результатов держать инлайн (свежие нужны модели, чтобы действовать по ним). */
export const DEFAULT_KEEP_RECENT_TOOL_RESULTS = 4;

/** Плейсхолдер вытесненного результата инструмента (структура сообщения при этом сохраняется). */
function offloadedPlaceholder(originalLength: number): string {
  return (
    `[прежний результат инструмента вытеснен для экономии контекста; было ~${originalLength} симв. — ` +
    'при необходимости вызови инструмент снова]'
  );
}

/**
 * Безопасная компакция истории агентного цикла (offload-приём вместо обрезки окном): если история
 * превышает бюджет, заменяет СОДЕРЖИМОЕ старых объёмных `tool`-сообщений коротким плейсхолдером,
 * СОХРАНЯЯ сами сообщения (роль, `tool_call_id`, порядок) — структура `assistant(tool_calls)→tool`
 * не рвётся, поэтому строгие провайдеры (GLM/z.ai) не бракуют запрос «messages illegal» (из-за этого
 * историю tool-цикла нельзя обрезать окном). Последние `keepRecent` результатов и всё прочее (system,
 * user-якорь с задачей/планом, assistant) не трогаются; результаты короче порога — тоже. Под бюджетом
 * массив возвращается как есть (короткие циклы — без изменений, регресс-безопасно).
 */
export function offloadOldToolResults(
  messages: ChatMessage[],
  budgetTokens: number,
  keepRecent = DEFAULT_KEEP_RECENT_TOOL_RESULTS,
): ChatMessage[] {
  if (historyTokens(messages) <= budgetTokens) {
    return messages;
  }
  const toolIndices = messages
    .map((message, index) => (message.role === 'tool' ? index : -1))
    .filter(index => index >= 0);
  const evictable = new Set(toolIndices.slice(0, Math.max(0, toolIndices.length - keepRecent)));
  return messages.map((message, index) =>
    evictable.has(index) && message.content.length > OFFLOAD_MIN_CHARS
      ? { ...message, content: offloadedPlaceholder(message.content.length) }
      : message,
  );
}

/**
 * Скользящее окно истории по токенам: всегда сохраняет системные сообщения и
 * оставляет самые свежие реплики, пока укладывается в бюджет. Самое последнее
 * сообщение сохраняется всегда — даже если оно одно превышает бюджет.
 *
 * Не рвёт группы tool-вызовов: `tool`-сообщение обязано следовать за `assistant` с
 * `tool_calls`. Если окно обрезало этот `assistant`, ведущие «осиротевшие» `tool`-ответы
 * тоже отбрасываются — иначе провайдер вернёт 400 («role 'tool' must follow tool_calls»).
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
  // Отбрасываем ведущие tool-ответы, чей assistant с tool_calls не попал в окно.
  let firstValid = 0;
  while (firstValid < keptInReverse.length && keptInReverse[firstValid].role === 'tool') {
    firstValid++;
  }
  return [...systemMessages, ...keptInReverse.slice(firstValid)];
}
