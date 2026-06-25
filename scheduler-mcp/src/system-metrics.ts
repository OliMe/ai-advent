/** Снимок метрик системы (в процентах). */
export interface SystemMetrics {
  memoryUsedPercent: number;
  cpuLoadPercent: number;
  diskFreePercent: number;
}

/** Источники системных метрик (шов для тестов; реальные — поверх node:os/fs). */
export interface SystemReaders {
  totalMemoryBytes(): number;
  freeMemoryBytes(): number;
  /** Средняя загрузка за 1 минуту (как os.loadavg()[0]). */
  loadAverage1m(): number;
  cpuCount(): number;
  /** Процент свободного места на корневом разделе. */
  diskFreePercent(): number;
}

/** Округление до одного знака после запятой. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Собирает снимок метрик: использование памяти, загрузка CPU (от числа ядер), свободный диск. */
export function collectSystemMetrics(readers: SystemReaders): SystemMetrics {
  const totalMemory = readers.totalMemoryBytes();
  const usedMemory = totalMemory - readers.freeMemoryBytes();
  const memoryUsedPercent = totalMemory > 0 ? round1((usedMemory / totalMemory) * 100) : 0;
  const cores = readers.cpuCount();
  const cpuLoadPercent = cores > 0 ? round1((readers.loadAverage1m() / cores) * 100) : 0;
  return {
    memoryUsedPercent,
    cpuLoadPercent,
    diskFreePercent: round1(readers.diskFreePercent()),
  };
}
