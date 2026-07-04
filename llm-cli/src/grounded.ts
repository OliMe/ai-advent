import type { Task, ToolSet } from '../../core/src/index.ts';
import { isSearchDocsTool } from './rag-directive.ts';

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

/** «Фокус» диалога для обогащения поискового запроса: цель задачи (title) + зафиксированные термины. */
export function groundedFocus(task: Task | null, invariants: string[]): string[] {
  return [...(task ? [task.title] : []), ...invariants];
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
