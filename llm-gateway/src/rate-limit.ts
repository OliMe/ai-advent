/** Вердикт ограничителя по одному запросу. */
export interface RateLimitDecision {
  /** Пропускаем ли запрос. */
  allowed: boolean;
  /** Сколько запросов осталось в ведре после этого (целая часть). */
  remaining: number;
  /** Через сколько секунд появится следующий токен (0, если запрос пропущен). */
  retryAfterSeconds: number;
}

/** Состояние ведра одного клиента. */
interface Bucket {
  tokens: number;
  updatedAtMs: number;
}

const MILLISECONDS_PER_MINUTE = 60_000;

/**
 * Ограничитель «ведро токенов»: ёмкость задаёт размер залпа, скорость пополнения —
 * устойчивый темп. Часы инжектируются, чтобы тесты не зависели от реального времени.
 */
export class TokenBucketRateLimiter {
  private readonly capacity: number;
  private readonly refillPerMinute: number;
  private readonly now: () => number;
  private readonly buckets: Map<string, Bucket>;

  constructor(capacity: number, refillPerMinute: number, now: () => number = Date.now) {
    this.capacity = capacity;
    this.refillPerMinute = refillPerMinute;
    this.now = now;
    this.buckets = new Map();
  }

  /** Пытается списать один токен у клиента и возвращает вердикт. */
  consume(identity: string): RateLimitDecision {
    const currentTimeMs = this.now();
    const bucket = this.buckets.get(identity) ?? {
      tokens: this.capacity,
      updatedAtMs: currentTimeMs,
    };

    const elapsedMs = currentTimeMs - bucket.updatedAtMs;
    const refilled = (elapsedMs / MILLISECONDS_PER_MINUTE) * this.refillPerMinute;
    const tokens = Math.min(this.capacity, bucket.tokens + refilled);

    if (tokens < 1) {
      this.buckets.set(identity, { tokens, updatedAtMs: currentTimeMs });
      const missing = 1 - tokens;
      const waitMs = (missing / this.refillPerMinute) * MILLISECONDS_PER_MINUTE;
      return { allowed: false, remaining: 0, retryAfterSeconds: Math.ceil(waitMs / 1000) };
    }

    this.buckets.set(identity, { tokens: tokens - 1, updatedAtMs: currentTimeMs });
    return { allowed: true, remaining: Math.floor(tokens - 1), retryAfterSeconds: 0 };
  }
}
