import type { Index, ScoredChunk } from '../../rag/src/index.ts';
import type { RetrieveTrace } from './retrieval.ts';

/** Однострочная трасса конвейера «до/после»: кандидаты → фильтр порога → rerank → итог (+ rewrite). */
export function formatTrace(trace: RetrieveTrace): string {
  const stages = [`кандидатов ${trace.candidates}`];
  if (trace.minScore > 0) {
    stages.push(`порог≥${trace.minScore.toFixed(2)}: ${trace.afterThreshold}`);
  }
  stages.push(`rerank(${trace.rerank}): ${trace.returned}`);
  const rewrite = trace.rewritten ? ', запрос переписан' : '';
  return `🔎 ${stages.join(' → ')}${rewrite}`;
}

/**
 * Форматирует найденные чанки в текст результата инструмента: строка-трасса стадий, затем
 * пронумерованные фрагменты с метками источника `[source › file › section]` и оценкой близости.
 * Этот текст уходит модели как результат вызова — по нему она и отвечает, ссылаясь на источники.
 */
export function formatResults(query: string, scored: ScoredChunk[], trace: RetrieveTrace): string {
  const diagnostics = formatTrace(trace);
  if (scored.length === 0) {
    return `По запросу «${query}» релевантных фрагментов не найдено.\n${diagnostics}`;
  }
  const blocks = scored.map(({ chunk, score }, index) => {
    const label = `[${index + 1}] ${chunk.source} › ${chunk.file} › ${chunk.section} (${score.toFixed(3)})`;
    return `${label}\n${chunk.text}`;
  });
  return `Найдено фрагментов: ${scored.length} по запросу «${query}»:\n${diagnostics}\n\n${blocks.join('\n\n')}`;
}

/** Краткая сводка кэшированных индексов для list_indexes. */
export function formatIndexes(indexes: Index[]): string {
  if (indexes.length === 0) {
    return 'Кэшированных индексов нет. Задайте source в search_docs — построю на лету.';
  }
  const lines = indexes.map(index => {
    const source = index.chunks[0]?.source ?? '(пусто)';
    return `• ${source} [${index.strategy}] — чанков: ${index.chunks.length}, модель: ${index.model}`;
  });
  return `Индексы (${indexes.length}):\n${lines.join('\n')}`;
}
