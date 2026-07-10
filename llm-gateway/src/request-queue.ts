/** Отказ: очередь заполнена, новый запрос не принимается. */
export class QueueOverflowError extends Error {
  constructor(maxDepth: number) {
    super(`Очередь заполнена: узел держит не больше ${maxDepth} запросов одновременно.`);
    this.name = 'QueueOverflowError';
  }
}

/**
 * Очередь на один исполняемый запрос: модель на CPU считает по одному запросу,
 * параллелизм только удлиняет ожидание всем. Сверх `maxDepth` — сразу отказ,
 * чтобы клиент не висел в неизвестности.
 */
export class RequestQueue {
  private readonly maxDepth: number;
  private tail: Promise<unknown>;
  private currentDepth: number;

  constructor(maxDepth: number) {
    this.maxDepth = maxDepth;
    this.tail = Promise.resolve();
    this.currentDepth = 0;
  }

  /** Сколько запросов сейчас в очереди, включая исполняемый. */
  get depth(): number {
    return this.currentDepth;
  }

  /**
   * Ставит задачу в очередь. `task` получает число ожидающих ВПЕРЕДИ него на момент
   * постановки (0 — исполняется сразу). Бросает `QueueOverflowError`, если мест нет.
   */
  async run<T>(task: (waitingAhead: number) => Promise<T>): Promise<T> {
    if (this.currentDepth >= this.maxDepth) {
      throw new QueueOverflowError(this.maxDepth);
    }
    const waitingAhead = this.currentDepth;
    this.currentDepth += 1;

    const previous = this.tail;
    const result = previous.then(() => task(waitingAhead));
    // Хвост не должен «заражаться» ошибкой задачи, иначе следующий в очереди её унаследует.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await result;
    } finally {
      this.currentDepth -= 1;
    }
  }
}
