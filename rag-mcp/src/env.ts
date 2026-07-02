import { join } from 'node:path';

/**
 * Путь к `.env` пакета относительно каталога модуля (`src`), а не текущего рабочего каталога.
 * Так конфиг сервера один и тот же, откуда бы его ни запустили (в т.ч. когда `llm-cli` поднимает
 * сервер как MCP-процесс с чужим cwd).
 */
export function packageEnvPath(moduleDirectory: string): string {
  return join(moduleDirectory, '..', '.env');
}

/**
 * Загружает `.env` пакета в `process.env`. Отсутствие файла — не ошибка (Ollama без ключа).
 * Уже заданные переменные окружения имеют приоритет (`loadEnvFile` их не перезаписывает), поэтому
 * `env`-блок записи сервера в `mcp.json` по-прежнему главнее файла. Загрузчик инъектируется — тестируемо.
 */
export function loadPackageEnv(moduleDirectory: string, loadEnvFile: (path: string) => void): void {
  try {
    loadEnvFile(packageEnvPath(moduleDirectory));
  } catch {
    // Файла нет — используем чистое окружение.
  }
}
