import { topK } from '../../rag/src/index.ts';
import type { EmbedFn, Index, ScoredChunk } from '../../rag/src/index.ts';
import { mmrRerank } from './mmr.ts';

/** Режим стадии rerank: `none` — как есть, `mmr` — MMR, `llm` — LLM/cross-encoder (через хук). */
export type RerankMode = 'none' | 'mmr' | 'llm';

/** Исход переранжирования кандидатов хуком: результат + признак фолбэка (не удалось оценить). */
export interface RerankOutcome {
  results: ScoredChunk[];
  /** true — переранжировать не удалось (напр. LLM вернул непарсимый ответ); порядок/скоры исходные. */
  fallback: boolean;
}

/** Параметры выборки: staged-конвейер эмбеддинг → topK(kPre) → фильтр порога → rerank → срез k. */
export interface RetrieveOptions {
  /** Итог после стадии rerank/фильтра. */
  k: number;
  /** Сколько доставать до стадии rerank/фильтра (kPre ≥ k). */
  kPre: number;
  /** Префикс запроса при эмбеддинге (nomic: «search_query: »); пусто — без префикса. */
  queryPrefix: string;
  /** Порог косинуса: чанки ниже отсекаются (0 — фильтр выключен). */
  minScore: number;
  /** Режим переранжирования. */
  rerank: RerankMode;
  /** Баланс релевантность/разнообразие для MMR (0..1). */
  mmrLambda: number;
  /** Сколько верхних кандидатов подавать в LLM-реранк (короткий список — надёжный ответ модели). */
  rerankLlmTop: number;
  /** Порог уверенности: лучший косинус ниже — результат помечается lowConfidence (для «не знаю»). */
  confidenceMin: number;
}

/** Опциональные хуки конвейера: переписывание запроса и LLM/cross-encoder переранжирование. */
export interface RetrieveHooks {
  /** Переписывание запроса перед эмбеддингом (expand/HyDE). Нет — берётся исходный запрос. */
  rewrite?: (query: string) => Promise<string>;
  /** Переранжирование кандидатов при rerank='llm'. Нет — стадия деградирует до 'none'. */
  rerankLlm?: (query: string, candidates: ScoredChunk[]) => Promise<RerankOutcome>;
}

/** Результат применения стадии rerank: переставленные кандидаты, фактический режим и признак фолбэка. */
interface RerankApplied {
  reranked: ScoredChunk[];
  effective: RerankMode;
  fallback: boolean;
}

/**
 * Применяет выбранную стадию переранжирования. Для `llm` в модель уходят только `rerankLlmTop`
 * верхних кандидатов (короткий список — надёжный парсинг), остальные приклеиваются после в исходном
 * порядке. Если LLM не смог оценить (фолбэк) — детерминированный MMR по тем же кандидатам (надёжный
 * запасной вариант вместо сырого косинуса), а `fallback` отражается в трассе.
 */
async function applyRerank(
  query: string,
  filtered: ScoredChunk[],
  options: RetrieveOptions,
  hooks: RetrieveHooks,
): Promise<RerankApplied> {
  if (options.rerank === 'mmr') {
    return {
      reranked: mmrRerank(filtered, options.k, options.mmrLambda),
      effective: 'mmr',
      fallback: false,
    };
  }
  if (options.rerank === 'llm' && hooks.rerankLlm) {
    const head = filtered.slice(0, options.rerankLlmTop);
    const tail = filtered.slice(options.rerankLlmTop);
    const outcome = await hooks.rerankLlm(query, head);
    const reordered = outcome.fallback
      ? mmrRerank(head, head.length, options.mmrLambda)
      : outcome.results;
    return { reranked: [...reordered, ...tail], effective: 'llm', fallback: outcome.fallback };
  }
  return { reranked: filtered, effective: 'none', fallback: false };
}

/** Трасса конвейера для наблюдаемости «до/после»: что применялось и сколько чанков на каждой стадии. */
export interface RetrieveTrace {
  /** Применялось ли переписывание запроса. */
  rewritten: boolean;
  /** Кандидатов после topK(kPre). */
  candidates: number;
  /** Порог фильтра (0 — выключен). */
  minScore: number;
  /** Осталось после фильтра порога. */
  afterThreshold: number;
  /** Лучший косинус в пуле кандидатов (после фильтра, до rerank) — метрика уверенности ретрива. */
  confidence: number;
  /** true — лучший косинус ниже порога уверенности: контекст слабый (повод сказать «не знаю»). */
  lowConfidence: boolean;
  /** Фактически применённый режим rerank (llm без хука → none). */
  rerank: RerankMode;
  /** true — LLM-реранк не смог оценить и откатился на MMR (в трассе «llm→mmr»). */
  rerankFallback: boolean;
  /** Итог после среза k. */
  returned: number;
  /** Язык корпуса, на который переведён/сгенерирован кросс-язычный rewrite (для трассы). Опц. */
  rewriteLanguage?: string;
}

/** Результат ретрива: сами чанки + трасса стадий. */
export interface RetrieveResult {
  results: ScoredChunk[];
  trace: RetrieveTrace;
}

/**
 * Ретрив релевантных чанков по индексам: (опц. переписывание запроса) → эмбеддинг с префиксом →
 * косинус top-`kPre` → фильтр по порогу `minScore` → стадия rerank (`none`/`mmr`/`llm`) → срез `k`.
 * Переранжирование судит по ИСХОДНОМУ запросу (не по переписанному тексту эмбеддинга — важно для HyDE).
 * Возвращает результат вместе с трассой стадий (для наблюдаемости «до/после»).
 */
export async function retrieve(
  query: string,
  indexes: Index[],
  options: RetrieveOptions,
  embed: EmbedFn,
  hooks: RetrieveHooks = {},
): Promise<RetrieveResult> {
  const embeddingQuery = hooks.rewrite ? await hooks.rewrite(query) : query;
  const [queryVector] = await embed([`${options.queryPrefix}${embeddingQuery}`]);
  const allChunks = indexes.flatMap(index => index.chunks);
  const preliminary = topK(queryVector, allChunks, options.kPre);
  const filtered =
    options.minScore > 0
      ? preliminary.filter(scored => scored.score >= options.minScore)
      : preliminary;
  // Уверенность = лучший косинус в пуле после фильтра (до rerank) — консистентная метрика,
  // не зависящая от режима rerank (llm/mmr меняют score). Пустой пул → 0 → низкая уверенность.
  const confidence = filtered[0]?.score ?? 0;
  const { reranked, effective, fallback } = await applyRerank(query, filtered, options, hooks);
  const results = reranked.slice(0, options.k);
  return {
    results,
    trace: {
      rewritten: hooks.rewrite !== undefined,
      candidates: preliminary.length,
      minScore: options.minScore,
      afterThreshold: filtered.length,
      confidence,
      lowConfidence: confidence < options.confidenceMin,
      rerank: effective,
      rerankFallback: fallback,
      returned: results.length,
    },
  };
}
