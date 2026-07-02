/** Режим переписывания запроса: `none` — без изменений, `expand` — обогащение, `hyde` — гипотетический документ. */
export type RewriteMode = 'none' | 'expand' | 'hyde';

/** Обёртка над chat-моделью: system + user промпты → текст ответа. Инъектируется (тестируемо). */
export type ChatComplete = (systemPrompt: string, userPrompt: string) => Promise<string>;

/** Промпт expand: короткое обогащение запроса синонимами и смежными терминами (для ретрива). */
const EXPAND_SYSTEM =
  'Ты помогаешь поиску по документации. По запросу пользователя выпиши через запятую ' +
  'ключевые синонимы, смежные термины и переформулировки (без пояснений, одной строкой) — ' +
  'чтобы расширить охват поиска. Отвечай на языке запроса.';

/** Промпт HyDE: сгенерировать краткий гипотетический ответ-документ на запрос (его и эмбеддим). */
const HYDE_SYSTEM =
  'Ты помогаешь поиску по документации методом HyDE. Напиши краткий (2–4 предложения) ' +
  'правдоподобный фрагмент документации, который бы отвечал на запрос пользователя, как будто ' +
  'он взят из искомого документа. Без оговорок и вступлений, только сам фрагмент. Язык — как в запросе.';

/**
 * Собирает функцию переписывания запроса под режим. `expand` дописывает к запросу обогащение,
 * `hyde` заменяет запрос гипотетическим документом; при пустом ответе модели — исходный запрос.
 * Режим `none` (или невалидный) → null: конвейер эмбеддит исходный запрос без обращения к модели.
 */
export function makeRewriter(
  mode: RewriteMode,
  complete: ChatComplete,
): ((query: string) => Promise<string>) | null {
  if (mode === 'expand') {
    return async query => {
      const expansion = (await complete(EXPAND_SYSTEM, query)).trim();
      return expansion ? `${query}\n${expansion}` : query;
    };
  }
  if (mode === 'hyde') {
    return async query => {
      const hypothetical = (await complete(HYDE_SYSTEM, query)).trim();
      return hypothetical || query;
    };
  }
  return null;
}
