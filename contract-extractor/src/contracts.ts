/** Маркер-разделитель договоров в исходном .txt по умолчанию. */
export const DEFAULT_SEPARATOR = '=====';

/**
 * Делит текст файла на отдельные договоры по строке-маркеру.
 * Пустые фрагменты (например, до первого и после последнего маркера) отбрасываются.
 */
export function splitContracts(text: string, separator: string): string[] {
  return text
    .split(separator)
    .map(part => part.trim())
    .filter(part => part.length > 0);
}

/** Разбивает массив на пакеты по `size` элементов. */
export function batch<T>(items: T[], size: number): T[][] {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(`Размер пакета должен быть положительным целым, получено: ${size}`);
  }
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}
