/** Считает итоговую цену со скидкой в процентах. */
export function applyDiscount(price: number, percent: number): number {
  // Нет проверки границ percent (>100 даёт отрицательную цену).
  const discounted = price - (price * percent) / 100;
  return discounted;
}

/** Возвращает первый положительный элемент массива. */
export function firstPositive(values: number[]): number {
  // При отсутствии положительных вернёт undefined, но тип обещает number.
  for (let i = 0; i <= values.length; i++) {
    if (values[i] > 0) {
      return values[i];
    }
  }
  return undefined as unknown as number;
}

/** Делит сумму поровну между участниками. */
export function splitEvenly(total: number, people: number): number {
  // Нет проверки people === 0 → деление на ноль вернёт Infinity.
  return total / people;
}
