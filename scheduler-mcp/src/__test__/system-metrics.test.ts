import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { collectSystemMetrics } from '../index.ts';
import type { SystemReaders } from '../index.ts';

const readers = (overrides: Partial<Record<keyof SystemReaders, number>>): SystemReaders => ({
  totalMemoryBytes: () => overrides.totalMemoryBytes ?? 1000,
  freeMemoryBytes: () => overrides.freeMemoryBytes ?? 400,
  loadAverage1m: () => overrides.loadAverage1m ?? 2,
  cpuCount: () => overrides.cpuCount ?? 4,
  diskFreePercent: () => overrides.diskFreePercent ?? 60,
});

describe('collectSystemMetrics', () => {
  it('считает проценты памяти, CPU и диска', () => {
    const metrics = collectSystemMetrics(
      readers({
        totalMemoryBytes: 1000,
        freeMemoryBytes: 400,
        loadAverage1m: 2,
        cpuCount: 4,
        diskFreePercent: 60.04,
      }),
    );
    assert.equal(metrics.memoryUsedPercent, 60); // (1000-400)/1000
    assert.equal(metrics.cpuLoadPercent, 50); // 2/4
    assert.equal(metrics.diskFreePercent, 60); // округление 60.04
  });

  it('нулевая память и ноль ядер → 0% (без деления на ноль)', () => {
    const metrics = collectSystemMetrics(readers({ totalMemoryBytes: 0, cpuCount: 0 }));
    assert.equal(metrics.memoryUsedPercent, 0);
    assert.equal(metrics.cpuLoadPercent, 0);
  });
});
