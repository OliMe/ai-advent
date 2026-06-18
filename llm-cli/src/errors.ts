/** Возвращает человекочитаемое описание ошибки. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') {
      return 'превышено время ожидания ответа от API.';
    }
    return error.message;
  }
  return String(error);
}

/** Сообщает о неперехваченной ошибке и помечает запуск как неуспешный. */
export function reportFatalError(error: unknown): void {
  console.error(`Ошибка: ${describeError(error)}`);
  process.exitCode = 1;
}
