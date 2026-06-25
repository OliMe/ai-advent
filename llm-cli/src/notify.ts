import { execFileSync } from 'node:child_process';

/** Запуск внешней команды для уведомления (шов для тестов). */
export type NotifyRunner = (command: string, args: string[]) => void;

/** Реальный запуск через child_process. */
export const realNotifyRunner: NotifyRunner = (command, args) => {
  execFileSync(command, args);
};

/** Аргументы osascript для системного уведомления macOS. */
function notifyScript(title: string, message: string): string[] {
  return [
    '-e',
    `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`,
  ];
}

/**
 * Показывает системное уведомление macOS (osascript). Best-effort: ошибки проглатываются
 * (уведомления — не критичный канал). Раннер инжектируется для тестов.
 */
export function systemNotify(
  title: string,
  message: string,
  runner: NotifyRunner = realNotifyRunner,
): void {
  try {
    runner('osascript', notifyScript(title, message));
  } catch {
    // уведомление не показалось — не критично
  }
}
