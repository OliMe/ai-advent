import type {
  ChatMessage,
  CompleteOptions,
  CompletionResult,
  StreamDelta,
} from '../../core/src/index.ts';

/** Вердикт гейта: годится ли сообщение как список продуктов для рецепта. */
export interface FoodVerdict {
  /** Съедобный список продуктов — можно готовить. */
  edible: boolean;
  /** Причина отказа (или пусто), как её сформулировала модель. */
  reason: string;
}

/**
 * Промпт гейта. Слабая 3B сама не откажется от постороннего запроса, поэтому решение
 * о допуске выносит ОТДЕЛЬНЫЙ классификатор с temperature 0 — не рецептурная модель.
 */
export const FOOD_GUARD_SYSTEM =
  'Ты — строгий классификатор запросов для кулинарного сервиса. ' +
  'Пользователь должен прислать список съедобных продуктов питания. ' +
  'Определи, из чего состоит сообщение.\n' +
  'Ответь ОДНИМ словом на первой строке:\n' +
  'ЕДА — если сообщение это список съедобных продуктов или ингредиентов для готовки;\n' +
  'НЕ_ЕДА — если в списке есть хоть один несъедобный предмет (инструмент, химия, ' +
  'предмет быта, животное и т.п.), ЛИБО сообщение вообще не про продукты (вопрос, ' +
  'просьба, посторонняя тема, оскорбление).\n' +
  'Консервы, тушёнка, продукты в таре (банка, пакет, бутылка) — это ЕДА: тара ' +
  'упоминается вместе с продуктом и не делает список несъедобным.\n' +
  'Затем со второй строки — короткая причина (одно предложение).';

/**
 * Few-shot примеры: на «банке тушёнки» голая инструкция плавала (тара путалась с
 * несъедобным), а с примерами классификатор дал 18/18 на проверочной батарее.
 */
export const FOOD_GUARD_EXAMPLES: ChatMessage[] = [
  { role: 'user', content: 'картофель, банка тушёнки, лавровый лист' },
  { role: 'assistant', content: 'ЕДА\nВсе позиции съедобны, тушёнка в банке — это консервы.' },
  { role: 'user', content: 'яйца, гвозди, лук' },
  { role: 'assistant', content: 'НЕ_ЕДА\nГвозди несъедобны.' },
  { role: 'user', content: 'посоветуй фильм на вечер' },
  { role: 'assistant', content: 'НЕ_ЕДА\nЭто не список продуктов питания.' },
];

/** Собирает диалог для гейта: инструкция, примеры, затем сообщение пользователя. */
export function buildFoodGuardMessages(userMessage: string): ChatMessage[] {
  return [
    { role: 'system', content: FOOD_GUARD_SYSTEM },
    ...FOOD_GUARD_EXAMPLES,
    { role: 'user', content: userMessage },
  ];
}

/**
 * Разбирает ответ классификатора. Первая строка — вердикт, остальное — причина.
 * Fail-closed: если вердикт не распознан как «ЕДА», отказываем (безопаснее пропустить
 * настоящий продукт по ошибке модели, чем сгенерировать рецепт из постороннего запроса).
 */
export function parseFoodVerdict(modelText: string): FoodVerdict {
  const lines = modelText
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);
  const verdictToken = (lines[0] ?? '').toUpperCase().replace(/[^А-ЯЁ_]/g, '');
  const reason = lines.slice(1).join(' ').trim();
  const saysNotFood = verdictToken.includes('НЕ_ЕДА') || verdictToken.includes('НЕЕДА');
  const edible = !saysNotFood && verdictToken.includes('ЕДА');
  return { edible, reason };
}

/** Текст отказа для пользователя; причину модели добавляем, если она есть. */
export function formatFoodRefusal(reason: string): string {
  const opening =
    'Я придумываю блюда только из съедобных продуктов — этот запрос к готовке не относится.';
  const closing = 'Перечислите, что нашли в холодильнике, и я предложу рецепт.';
  return reason.length > 0 ? `${opening}\n\n${reason}\n\n${closing}` : `${opening}\n\n${closing}`;
}

/** Минимальный клиент, нужный гейту (структурно совпадает с ChatCompletionClient ядра). */
export interface GuardChatClient {
  streamWithUsage(
    messages: ChatMessage[],
    options: CompleteOptions,
    onDelta: (delta: StreamDelta) => void,
  ): Promise<CompletionResult>;
}

/** Потолок ответа гейта: вердикт плюс короткая причина укладываются с запасом. */
const GUARD_MAX_TOKENS = 48;

/**
 * Строит оценщик съедобности поверх фабрики клиентов. Классификация идёт на temperature 0
 * (нужен стабильный вердикт, а не разнообразие).
 */
export function makeFoodAssessor(
  createClient: (model: string) => GuardChatClient,
): (model: string, userMessage: string) => Promise<FoodVerdict> {
  return async (model, userMessage) => {
    const client = createClient(model);
    let streamed = '';
    const result = await client.streamWithUsage(
      buildFoodGuardMessages(userMessage),
      { temperature: 0, maxTokens: GUARD_MAX_TOKENS },
      delta => {
        if (delta.content !== undefined) {
          streamed += delta.content;
        }
      },
    );
    return parseFoodVerdict(result.content.length > 0 ? result.content : streamed);
  };
}
