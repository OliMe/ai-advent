/** Честный ценник ответа: во что он обошёлся узлу. */
export interface AnswerCost {
  /** Сколько времени ответ занял целиком по часам, секунд. */
  wallSeconds: number;
  /**
   * Время до первого токена, секунд. Сюда попадает и подгрузка модели в память
   * (~4 с при смене персоны), и обработка промпта.
   */
  timeToFirstTokenSeconds: number;
  /** Сколько процессорного времени сожжено, секунд (стенные секунды × выданные ядра). */
  cpuSeconds: number;
  /** Сколько токенов сгенерировано. */
  generatedTokens: number;
  /**
   * Скорость собственно генерации, токенов в секунду: считается по окну от первого
   * токена до последнего. Ожидание модели сюда не входит, иначе цифра врёт.
   */
  tokensPerSecond: number;
}

/** Засечки времени, снятые по ходу одного ответа. */
export interface AnswerTimings {
  /** Полное время обслуживания, мс. */
  wallMilliseconds: number;
  /** Время от начала запроса до первого токена, мс. */
  timeToFirstTokenMilliseconds: number;
  /** Длительность окна генерации (первый токен → последний), мс. */
  generationMilliseconds: number;
}

/**
 * Считает стоимость ответа. Ядер берём столько, сколько отдано модели через CPUQuota:
 * модель занимает их целиком, пока считает.
 */
export function describeAnswerCost(
  timings: AnswerTimings,
  quotaCores: number,
  generatedTokens: number,
): AnswerCost {
  const wallSeconds = timings.wallMilliseconds / 1000;
  const generationSeconds = timings.generationMilliseconds / 1000;
  return {
    wallSeconds,
    timeToFirstTokenSeconds: timings.timeToFirstTokenMilliseconds / 1000,
    cpuSeconds: wallSeconds * quotaCores,
    generatedTokens,
    tokensPerSecond: generationSeconds > 0 ? generatedTokens / generationSeconds : 0,
  };
}

/** Человекочитаемая подпись под ответом. */
export function formatAnswerCost(cost: AnswerCost): string {
  return (
    `${cost.cpuSeconds.toFixed(1)} CPU-секунд · ` +
    `${cost.timeToFirstTokenSeconds.toFixed(1)} с до первого токена · ` +
    `${cost.generatedTokens} токенов на ${cost.tokensPerSecond.toFixed(1)} токенов/с · ` +
    `${cost.wallSeconds.toFixed(1)} с всего`
  );
}
