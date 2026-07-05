import type { Index, ScoredChunk } from '../../rag/src/index.ts';
import type { RetrieveTrace } from './retrieval.ts';

/** Однострочная трасса конвейера «до/после»: кандидаты → фильтр порога → rerank → итог (+ rewrite). */
export function formatTrace(trace: RetrieveTrace): string {
  const stages = [`кандидатов ${trace.candidates}`];
  if (trace.minScore > 0) {
    stages.push(`порог≥${trace.minScore.toFixed(2)}: ${trace.afterThreshold}`);
  }
  // Фолбэк LLM-реранка (модель не дала годных скоров) виден как «llm→mmr» — честно, что сработал MMR.
  const rerankLabel = trace.rerankFallback ? `${trace.rerank}→mmr` : trace.rerank;
  stages.push(`rerank(${rerankLabel}): ${trace.returned}`);
  // Кросс-язычный rewrite: показываем язык корпуса, на который переведён/сгенерирован запрос.
  const rewriteLang = trace.rewriteLanguage !== undefined ? `→${trace.rewriteLanguage}` : '';
  const rewrite = trace.rewritten ? `, запрос переписан${rewriteLang}` : '';
  // Уверенность ретрива + пометка «(низкая)» — сигнал для режима «не знаю».
  const confidence = ` · уверенность ${trace.confidence.toFixed(2)}${trace.lowConfidence ? ' (низкая)' : ''}`;
  return `🔎 ${stages.join(' → ')}${rewrite}${confidence}`;
}

/**
 * Форматирует найденные чанки в текст результата инструмента: строка-трасса стадий (+ пометка низкой
 * уверенности), затем пронумерованные фрагменты с парсируемым заголовком `[n] chunk_id · source ›
 * file › section (score)` и телом чанка. `chunk_id` в заголовке нужен, чтобы модель ссылалась на
 * источник по идентификатору, а клиент (llm-cli) сверял дословные цитаты с конкретным чанком.
 */
export function formatResults(query: string, scored: ScoredChunk[], trace: RetrieveTrace): string {
  const diagnostics = formatTrace(trace);
  const notice = trace.lowConfidence
    ? `\n⚠ Низкая уверенность контекста (лучший косинус ${trace.confidence.toFixed(2)}).`
    : '';
  if (scored.length === 0) {
    return `По запросу «${query}» релевантных фрагментов не найдено.\n${diagnostics}${notice}`;
  }
  const blocks = scored.map(({ chunk, score }, index) => {
    const label = `[${index + 1}] ${chunk.chunk_id} · ${chunk.source} › ${chunk.file} › ${chunk.section} (${score.toFixed(3)})`;
    return `${label}\n${chunk.text}`;
  });
  return `Найдено фрагментов: ${scored.length} по запросу «${query}»:\n${diagnostics}${notice}\n\n${blocks.join('\n\n')}`;
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
