/** Снимок состояния узла, из которого выводится его настроение. */
export interface SystemMetrics {
  /** Доля простаивающего процессора, проценты (0..100). */
  cpuIdlePercent: number;
  /** Средняя загрузка за минуту. */
  loadAverage1m: number;
  /** Доля доступной памяти от общей (0..1). */
  memoryAvailableRatio: number;
}

/** Накопительные счётчики процессора из /proc/stat. */
export interface CpuTotals {
  idle: number;
  total: number;
}

/** Источник сырых данных ядра; подменяется в тестах. */
export interface ProcFileSource {
  readStat(): string;
  readMemInfo(): string;
  readLoadAverage(): string;
}

/**
 * Разбирает суммарную строку `cpu` из /proc/stat. Простоем считаем idle+iowait:
 * ожидание диска процессор тоже не занимает.
 */
export function parseCpuTotals(procStatText: string): CpuTotals {
  const line = procStatText.split('\n').find(candidate => candidate.startsWith('cpu '));
  if (line === undefined) {
    throw new Error('В /proc/stat нет суммарной строки «cpu».');
  }
  const values = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = values[3] + values[4];
  const total = values.reduce((sum, value) => sum + value, 0);
  return { idle, total };
}

/** Достаёт из /proc/meminfo общую и доступную память (в килобайтах). */
export function parseMemoryAvailableRatio(procMemInfoText: string): number {
  const readField = (name: string): number => {
    const line = procMemInfoText.split('\n').find(candidate => candidate.startsWith(`${name}:`));
    if (line === undefined) {
      throw new Error(`В /proc/meminfo нет поля «${name}».`);
    }
    return Number(line.trim().split(/\s+/)[1]);
  };
  return readField('MemAvailable') / readField('MemTotal');
}

/** Берёт среднюю загрузку за минуту — первое число из /proc/loadavg. */
export function parseLoadAverage(procLoadAverageText: string): number {
  return Number(procLoadAverageText.trim().split(/\s+/)[0]);
}

/**
 * Считает долю простоя процессора между двумя вызовами. Первый вызов сравнивать
 * не с чем — возвращается средний простой с момента загрузки системы.
 */
export class CpuIdleTracker {
  private previous: CpuTotals | undefined;

  /** Обновляет снимок счётчиков и возвращает долю простоя в процентах. */
  sample(procStatText: string): number {
    const current = parseCpuTotals(procStatText);
    const baseline = this.previous ?? { idle: 0, total: 0 };
    this.previous = current;

    const idleDelta = current.idle - baseline.idle;
    const totalDelta = current.total - baseline.total;
    if (totalDelta <= 0) {
      return 100;
    }
    return (idleDelta / totalDelta) * 100;
  }
}

/** Собирает снимок метрик узла из /proc, используя накопитель простоя процессора. */
export function readSystemMetrics(source: ProcFileSource, tracker: CpuIdleTracker): SystemMetrics {
  return {
    cpuIdlePercent: tracker.sample(source.readStat()),
    loadAverage1m: parseLoadAverage(source.readLoadAverage()),
    memoryAvailableRatio: parseMemoryAvailableRatio(source.readMemInfo()),
  };
}
