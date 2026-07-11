import type { ChatMessage, Task, ToolSet } from '../../core/src/index.ts';
import { isSearchDocsTool } from './rag-directive.ts';
import { normalizeForMatch } from './citation-guard.ts';

/** Явно разговорные реплики (не вопросы к документам) — на них grounded-поиск не запускается. */
const FILLERS = new Set([
  'привет',
  'здравствуй',
  'здравствуйте',
  'хай',
  'спасибо',
  'благодарю',
  'спс',
  'пока',
  'до свидания',
  'ок',
  'окей',
  'ok',
  'да',
  'нет',
  'ага',
  'угу',
  'понятно',
  'ясно',
  'хорошо',
  'класс',
  'круто',
  'супер',
  'отлично',
  'пожалуйста',
  'ладно',
]);

/**
 * Разговорная ли реплика (приветствие/благодарность/да-нет/очень короткая) — тогда в grounded-режиме
 * обычный ответ без RAG. Консервативно: содержательный вопрос (даже с «спасибо, а как…») → false.
 */
export function isConversationalReply(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length <= 2) {
    return true;
  }
  const normalized = trimmed
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return FILLERS.has(normalized);
}

/**
 * Высокоточные маркеры вопроса-воспоминания (нормализованные: строчные, без пунктуации). Ловят
 * ОЧЕВИДНЫЕ случаи детерминированно; перефразировки добирает LLM-флаг recall (гибрид). Держим набор
 * узким (мало ложных срабатываний): на широкое покрытие работает именно LLM-сигнал.
 */
const RECALL_MARKERS = [
  'напомни',
  'повтори',
  'ещё раз',
  'еще раз',
  'что мы решили',
  'что мы обсуждали',
  'что мы выбрали',
  'с чего начали',
  'какая у нас задача',
  'какая у нас цель',
  'наша задача',
  'наша цель',
  'что ты называл',
  'что ты говорил',
  'что ты сказал',
  'к чему пришли',
  'что зафиксировали',
];

/**
 * Температура синтеза grounded-ответа (и перегенерации цитатного гейта): НИЗКАЯ — ответ собирается
 * строго по найденным фрагментам, творчество тут вредит (точность/достоверность + стабильность,
 * меньше шума на повторных прогонах). env `RAG_ANSWER_TEMPERATURE`, дефолт 0.2; невалидное/отрицательное
 * → дефолт. Не связано с `response_format`, поэтому безопасно для всех провайдеров (GLM/DeepSeek/локаль).
 */
export function resolveRagAnswerTemperature(raw: string | undefined): number {
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : 0.2;
}

/** Лексический детектор вопроса-воспоминания: нормализованный текст содержит один из маркеров. */
export function isRecallQuestion(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return RECALL_MARKERS.some(marker => normalized.includes(marker));
}

/**
 * Гибридное решение «это ход-воспоминание»: LLM-флаг извлечения (`MemoryWriteReport.recall`, устойчив
 * к формулировкам) ⋁ лексический маркер (детерминированный fast-path, работает и при выключенной памяти).
 */
export function isRecallTurn(text: string, llmRecallFlag: boolean): boolean {
  return llmRecallFlag || isRecallQuestion(text);
}

/**
 * Внутренний сигнал: подходящего ответа в истории нет → откат на обычный grounded-поиск. Чисто
 * технический — пользователю НЕ показывается (обнаружив его в ответе, клиент молча идёт на откат).
 */
export const RECALL_SENTINEL = 'НЕТ_ОТВЕТА_В_ИСТОРИИ';

/**
 * System-промпт хода-воспоминания: воспроизвести прошлый ответ ДОСЛОВНО (с секцией «Источники»),
 * без поиска в базе; нет такого в истории — вернуть только сентинел (тогда клиент откатится на поиск).
 */
export const RECALL_SYSTEM_PROMPT =
  'Это вопрос-воспоминание: пользователь просит вспомнить или повторить то, что уже было в ЭТОМ ' +
  'диалоге. Найди в истории свой предыдущий ответ по теме вопроса и воспроизведи его МАКСИМАЛЬНО ' +
  'ДОСЛОВНО, включая секцию «Источники» (если она была). Ничего не добавляй от себя, не ищи в базе. ' +
  `Если подходящего ответа в истории НЕТ — верни РОВНО ${RECALL_SENTINEL} и больше ничего.`;

/**
 * Предохранитель grounded-режима: форс-поиск ничего не добыл (инструмент `search_docs` недоступен —
 * напр. rag-сервер отвалился), значит фрагментов в контексте нет. В grounded НЕ выдаём необоснованный
 * ответ модели (иначе слабая модель галлюцинирует несуществующие факты и источники) — сообщаем о сбое.
 */
export const RAG_SEARCH_UNAVAILABLE =
  '⚠ Не удалось обратиться к базе знаний: поиск по документам (search_docs) недоступен — возможно, ' +
  'rag-сервер отвалился. В grounded-режиме без источников не отвечаю. Проверьте подключение ' +
  '(`/mcp reload`) и повторите вопрос.';

/**
 * Нужен ли откат на grounded-поиск: ответ хода-воспоминания содержит сентинел (даже обёрнутый прозой —
 * тогда весь такой ответ отбрасываем, чтобы сентинел не утёк в вывод).
 */
export function isRecallFallback(answer: string): boolean {
  return answer.toUpperCase().includes(RECALL_SENTINEL);
}

/** Минимум подряд идущих слов совпадения — якорь; короче терпит случайные совпадения. */
const RECALL_ANCHOR_MIN_WORDS = 6;

/**
 * Заякорен ли ответ-воспоминание в истории: настоящий recall ДОСЛОВНО воспроизводит прошлый ответ,
 * поэтому его тело должно содержать непрерывную нормализованную подстроку (≥ `RECALL_ANCHOR_MIN_WORDS`
 * слов) из прежних ассистентских сообщений. Детерминированный откат, НЕ зависящий от того, честно ли
 * слабая модель вернула сентинел: LLM-флаг `recall` ложно-положителен на слабых моделях, и без якоря
 * recall-проба выдаёт галлюцинацию вместо реального воспроизведения. Нет прошлых ответов (первый ход)
 * → якоря быть не может → false → откат на grounded. Гибкость recall не теряется: проба идёт всегда,
 * отсекается лишь НЕподтверждённый результат.
 */
export function recallAnchoredInHistory(recallAnswer: string, history: ChatMessage[]): boolean {
  const haystack = history
    .filter(message => message.role === 'assistant')
    .map(message => normalizeForMatch(message.content))
    .join(' ');
  if (haystack === '') {
    return false;
  }
  const words = normalizeForMatch(recallAnswer)
    .split(' ')
    .filter(word => word.length > 0);
  if (words.length < RECALL_ANCHOR_MIN_WORDS) {
    return false;
  }
  for (let start = 0; start + RECALL_ANCHOR_MIN_WORDS <= words.length; start++) {
    const window = words.slice(start, start + RECALL_ANCHOR_MIN_WORDS).join(' ');
    if (haystack.includes(window)) {
      return true;
    }
  }
  return false;
}

/**
 * «Фокус» диалога для обогащения поискового запроса — ТОЛЬКО цель задачи (title). Инварианты сюда НЕ
 * входят: это поведенческие правила ассистента (в контекст ответа подмешиваются отдельно), а к поиску
 * по документам отношения не имеют — в запросе они лишь зашумляют эмбеддинг (напр. «Не добавлять в
 * tasks.md…» уводил ретрив от темы вопроса).
 */
export function groundedFocus(task: Task | null): string[] {
  return task ? [task.title] : [];
}

/**
 * Обогащает поисковый запрос целью/терминами из памяти задачи — держит цель и чинит follow-up’ы
 * («а подробнее?» получает контекст). Пустой фокус → запрос как есть.
 */
export function buildGroundedQuery(userInput: string, focus: string[]): string {
  const parts = focus.filter(part => part.trim() !== '');
  return parts.length === 0 ? userInput : `${userInput}\nКонтекст диалога: ${parts.join('; ')}`;
}

/**
 * Детерминированный grounded-поиск: вызывает `search_docs` по КАЖДОМУ привязанному источнику с
 * обогащённым запросом, возвращает список результатов (их объединение потом сверяет цитатный гейт).
 * Нет инструмента поиска среди подключённых — пустой список (grounded-режим не сработает).
 */
export async function forcedRagSearch(
  toolSet: ToolSet,
  sources: string[],
  query: string,
  onSearch?: (name: string, args: Record<string, unknown>, result: string) => void,
): Promise<string[]> {
  const name = toolSet.specs().find(spec => isSearchDocsTool(spec.name))?.name;
  if (name === undefined) {
    return [];
  }
  const results: string[] = [];
  for (const source of sources) {
    const args = { query, source };
    const result = await toolSet.call(name, args);
    onSearch?.(name, args, result);
    results.push(result);
  }
  return results;
}
