import type { TaskRun } from './types.ts';

/** Сводка по серии метрик-запусков. null — данных по метрике нет. */
export interface MetricsAggregate {
  count: number;
  availabilityPercent: number | null;
  peakMemoryPercent: number | null;
  peakCpuPercent: number | null;
  diskFreePercent: number | null;
  avgLatencyMs: number | null;
}

/** Число из details по ключу или null. */
function numberAt(details: Record<string, unknown>, key: string): number | null {
  const value = details[key];
  return typeof value === 'number' ? value : null;
}

/** Округление до одного знака. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Максимум значений ключа по запускам или null, если значений нет. */
function peak(runs: TaskRun[], key: string): number | null {
  const values = runs.map(run => numberAt(run.details, key)).filter((v): v is number => v !== null);
  return values.length > 0 ? round1(Math.max(...values)) : null;
}

/** Агрегирует серию метрик-запусков: доступность, пики RAM/CPU, свободный диск, средняя задержка. */
export function aggregateMetrics(runs: TaskRun[]): MetricsAggregate {
  const availabilityFlags = runs
    .map(run => run.details.available)
    .filter((v): v is boolean => typeof v === 'boolean');
  const availabilityPercent =
    availabilityFlags.length > 0
      ? round1((availabilityFlags.filter(Boolean).length / availabilityFlags.length) * 100)
      : null;
  const latencies = runs
    .map(run => numberAt(run.details, 'latencyMs'))
    .filter((v): v is number => v !== null);
  const avgLatencyMs =
    latencies.length > 0
      ? round1(latencies.reduce((sum, value) => sum + value, 0) / latencies.length)
      : null;
  const diskValues = runs
    .map(run => numberAt(run.details, 'diskFreePercent'))
    .filter((v): v is number => v !== null);
  return {
    count: runs.length,
    availabilityPercent,
    peakMemoryPercent: peak(runs, 'memoryUsedPercent'),
    peakCpuPercent: peak(runs, 'cpuLoadPercent'),
    diskFreePercent: diskValues.length > 0 ? round1(diskValues[diskValues.length - 1]) : null,
    avgLatencyMs,
  };
}

/** Значение метрики или прочерк. */
function show(value: number | null, suffix: string): string {
  return value === null ? '—' : `${value}${suffix}`;
}

/** Человекочитаемый отчёт по агрегату метрик. */
export function formatReport(aggregate: MetricsAggregate): string {
  if (aggregate.count === 0) {
    return 'Данных для отчёта пока нет.';
  }
  return (
    `Сводка за период (${aggregate.count} замер(ов)):\n` +
    `• доступность: ${show(aggregate.availabilityPercent, '%')}\n` +
    `• средняя задержка: ${show(aggregate.avgLatencyMs, ' мс')}\n` +
    `• свободно на диске: ${show(aggregate.diskFreePercent, '%')}\n` +
    `• пик памяти: ${show(aggregate.peakMemoryPercent, '%')}\n` +
    `• пик CPU: ${show(aggregate.peakCpuPercent, '%')}`
  );
}
