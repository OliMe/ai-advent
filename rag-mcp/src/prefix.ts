import type { EmbedFn } from '../../rag/src/index.ts';

/**
 * Оборачивает эмбеддер, добавляя префикс к каждому входу (для моделей с префиксами задачи, напр.
 * nomic-embed-text: «search_document: » для документов). Пустой префикс — вход без изменений.
 * Хранимый текст чанка НЕ меняется — префикс идёт только в эмбеддинг.
 */
export function withPrefix(embed: EmbedFn, prefix: string): EmbedFn {
  return inputs => embed(inputs.map(input => `${prefix}${input}`));
}
