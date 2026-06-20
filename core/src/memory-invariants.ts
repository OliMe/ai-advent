import type { InvariantsStore } from './invariants-store.ts';
import type { ChatMessage } from './types.ts';
import { capToBudget } from './tokens.ts';

/**
 * Слой инвариантов: владеет глобальным списком жёстких ограничений и его хранилищем
 * (null — режим в памяти процесса). Добавление/удаление/список и рендер защищённого
 * системного блока для контекста агентов.
 */
export class InvariantsMemory {
  private readonly store: InvariantsStore | null;
  private items: string[];

  constructor(store: InvariantsStore | null) {
    this.store = store;
    this.items = store !== null ? store.load() : [];
  }

  /** Текущий список инвариантов. */
  all(): string[] {
    return [...this.items];
  }

  /** Сохраняет список в хранилище (если есть). */
  private persist(): void {
    this.store?.save(this.items);
  }

  /**
   * Добавляет инвариант (с дедупликацией и обрезкой пробелов). Возвращает добавленный
   * текст или null, если пусто/дубль.
   */
  add(text: string): string | null {
    const trimmed = text.trim();
    if (trimmed === '' || this.items.includes(trimmed)) {
      return null;
    }
    this.items.push(trimmed);
    this.persist();
    return trimmed;
  }

  /**
   * Удаляет инварианты по номерам (1-based). Резолвит индексы ДО удаления; невалидные
   * игнорирует. Возвращает удалённые тексты (в порядке возрастания номера).
   */
  remove(oneBasedIndices: number[]): string[] {
    const drop = new Set<number>();
    for (const oneBased of oneBasedIndices) {
      const index = oneBased - 1;
      if (index >= 0 && index < this.items.length) {
        drop.add(index);
      }
    }
    if (drop.size === 0) {
      return [];
    }
    const removed = [...drop].sort((a, b) => a - b).map(index => this.items[index]);
    this.items = this.items.filter((_, index) => !drop.has(index));
    this.persist();
    return removed;
  }

  /** Защищённый системный блок инвариантов (или null, если их нет). */
  block(budgetTokens: number): ChatMessage | null {
    if (this.items.length === 0) {
      return null;
    }
    const body = capToBudget(this.items.map(item => `- ${item}`).join('\n'), budgetTokens);
    return { role: 'system', content: `ИНВАРИАНТЫ (нарушать нельзя):\n${body}` };
  }
}
