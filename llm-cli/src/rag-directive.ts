import type { ToolSpec } from '../../core/src/index.ts';

/** Суффикс имени инструмента поиска по документам (с учётом неймспейса «сервер__search_docs»). */
const SEARCH_TOOL_SUFFIX = 'search_docs';

/** Подходит ли инструмент под RAG-поиск (по суффиксу имени). */
export function isSearchDocsTool(name: string): boolean {
  return name.endsWith(SEARCH_TOOL_SUFFIX);
}

/**
 * Компактная сводка результата search_docs для показа в чате: строка-трасса стадий (🔎) и заголовки
 * найденных фрагментов `[n] source › file › section (score)` — без тел фрагментов (те и так уходят
 * модели в контекст). Так пользователь ВИДИТ, что и в каком порядке нашлось при разных режимах
 * (rerank/rewrite/порог), а не только сглаженный финальный ответ.
 */
export function formatRagResultForDisplay(result: string): string {
  return result
    .split('\n')
    .filter(line => line.startsWith('🔎') || /^\[\d+\]/.test(line))
    .join('\n');
}

/**
 * Директива агенту, когда доступен инструмент поиска по документам (RAG). Нацеливает: на вопросы
 * о конкретном репозитории/сайте/папке или ранее проиндексированных данных — вызвать search_docs
 * (с source из вопроса, если он есть) и отвечать строго по возвращённым фрагментам со ссылками на
 * источники. Возвращает null, если такого инструмента нет.
 */
export function ragSearchDirective(specs: ToolSpec[]): string | null {
  if (!specs.some(spec => isSearchDocsTool(spec.name))) {
    return null;
  }
  return (
    'Тебе доступен инструмент поиска по документам (search_docs) с индексацией на лету. Если ' +
    'вопрос касается конкретного репозитория, сайта или папки (в вопросе есть ссылка github.com, ' +
    'URL или путь) либо ранее проиндексированных данных — ВЫЗОВИ search_docs (передай source из ' +
    'вопроса, если он указан) и отвечай СТРОГО по возвращённым фрагментам, указывая источники ' +
    '(вида «file › section»). Если релевантного не нашлось — так и скажи, не выдумывай.'
  );
}
