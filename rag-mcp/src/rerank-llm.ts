import type { ScoredChunk } from '../../rag/src/index.ts';
import type { ChatComplete } from './rewrite.ts';
import type { RerankOutcome } from './retrieval.ts';

/** Скоры релевантности от провайдера + признак фолбэка (провайдер не смог оценить — сохранить порядок). */
export interface RerankScores {
  /** По одному скору на кандидата (в исходном порядке). */
  scores: number[];
  /** true — годных скоров нет (напр. LLM вернул непарсимый ответ); скоры-заглушка, порядок не менять. */
  fallback: boolean;
}

/**
 * Провайдер переранжирования: по запросу и текстам кандидатов возвращает скоры релевантности
 * (по одному на кандидата, тот же контракт, что `/rerank` у cross-encoder — bge-reranker и т.п.).
 * Сейчас реализуется через chat-LLM; в будущем тем же интерфейсом — настоящий cross-encoder.
 */
export type RerankProvider = (query: string, texts: string[]) => Promise<RerankScores>;

/** Промпт chat-реранкера: оценить релевантность каждого фрагмента запросу и вернуть JSON-массив. */
const RERANK_SYSTEM =
  'Ты — реранкер поиска. Для КАЖДОГО пронумерованного фрагмента оцени, насколько он релевантен ' +
  'запросу, числом от 0 (не относится) до 1 (прямо отвечает). Верни ТОЛЬКО JSON-массив чисел в ' +
  'порядке фрагментов, без пояснений. Пример: [0.9, 0.1, 0.5].';

/**
 * Разбирает ответ модели в массив скоров нужной длины. Не удалось (нет массива, неверная длина,
 * битый JSON) → `fallback: true` со скорами-заглушкой (убывают по позиции — сохраняют исходный
 * порядок). Нечисловой элемент → 0.
 */
export function parseScores(raw: string, count: number): RerankScores {
  const fallback: RerankScores = {
    scores: Array.from({ length: count }, (_, index) => count - index),
    fallback: true,
  };
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) {
    return fallback;
  }
  try {
    const parsed: unknown = JSON.parse(match[0]);
    if (!Array.isArray(parsed) || parsed.length !== count) {
      return fallback;
    }
    const scores = parsed.map(value =>
      typeof value === 'number' && Number.isFinite(value) ? value : 0,
    );
    return { scores, fallback: false };
  } catch {
    return fallback;
  }
}

/** Chat-реализация RerankProvider: просит модель проставить скоры релевантности фрагментам. */
export function makeChatRerankProvider(complete: ChatComplete): RerankProvider {
  return async (query, texts) => {
    const numbered = texts.map((text, index) => `[${index}] ${text}`).join('\n\n');
    const answer = await complete(RERANK_SYSTEM, `Запрос: ${query}\n\nФрагменты:\n${numbered}`);
    return parseScores(answer, texts.length);
  };
}

/**
 * Оборачивает провайдер скоров в переранжировщик кандидатов. Успех: заменяет score на оценку
 * провайдера и сортирует по убыванию. Фолбэк (провайдер не смог оценить) или пустой вход: кандидаты
 * как есть, с исходными скорами и порядком (без фейковых чисел) — вызывающий решит, что делать
 * (в конвейере фолбэк уходит на детерминированный MMR). Признак фолбэка — в `RerankOutcome.fallback`.
 */
export function makeLlmReranker(
  provider: RerankProvider,
): (query: string, candidates: ScoredChunk[]) => Promise<RerankOutcome> {
  return async (query, candidates) => {
    if (candidates.length === 0) {
      return { results: candidates, fallback: false };
    }
    const { scores, fallback } = await provider(
      query,
      candidates.map(candidate => candidate.chunk.text),
    );
    if (fallback) {
      return { results: candidates, fallback: true };
    }
    const results = candidates
      .map((candidate, index) => ({
        chunk: candidate.chunk,
        score: scores[index] ?? candidate.score,
      }))
      .sort((first, second) => second.score - first.score);
    return { results, fallback: false };
  };
}
