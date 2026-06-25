/** Снимок счётчика запросов. */
export interface RequestCounterSnapshot {
  /** Сколько раз вызывали распознавание с момента запуска. */
  requests: number;
  /** Момент запуска счётчика (ISO). */
  since: string;
}

/**
 * Счётчик обращений к распознаванию: инкремент на каждый вызов инструмента, снимок для
 * эндпоинта метрик. Момент старта задаётся явно (шов для тестов).
 */
export class RequestCounter {
  private requests = 0;
  private readonly since: string;

  constructor(since: string) {
    this.since = since;
  }

  /** Учитывает один вызов распознавания. */
  increment(): void {
    this.requests += 1;
  }

  /** Текущее состояние счётчика. */
  snapshot(): RequestCounterSnapshot {
    return { requests: this.requests, since: this.since };
  }
}
