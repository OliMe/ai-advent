import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateMetrics, formatReport } from '../index.ts';
import type { TaskRun } from '../index.ts';

const run = (details: Record<string, unknown>): TaskRun => ({
  id: 'r',
  taskId: 't',
  taskTitle: 'T',
  firedAt: '2026-01-01T00:00:00.000Z',
  ok: true,
  summary: '',
  details,
});

describe('aggregateMetrics', () => {
  it('агрегирует доступность, пики, последний диск и среднюю задержку', () => {
    const aggregate = aggregateMetrics([
      run({
        memoryUsedPercent: 50,
        cpuLoadPercent: 10,
        diskFreePercent: 70,
        available: true,
        latencyMs: 100,
      }),
      run({
        memoryUsedPercent: 80,
        cpuLoadPercent: 30,
        diskFreePercent: 65,
        available: false,
        latencyMs: 200,
      }),
    ]);
    assert.deepEqual(aggregate, {
      count: 2,
      availabilityPercent: 50,
      peakMemoryPercent: 80,
      peakCpuPercent: 30,
      diskFreePercent: 65,
      avgLatencyMs: 150,
      maxRequests: null,
    });
  });

  it('число запросов OCR попадает в сводку (макс)', () => {
    const aggregate = aggregateMetrics([run({ requests: 10 }), run({ requests: 42 })]);
    assert.equal(aggregate.maxRequests, 42);
    assert.match(formatReport(aggregate), /запросов к OCR \(макс\.\): 42/);
  });

  it('пустая серия → нули/null и отчёт «нет данных»', () => {
    const aggregate = aggregateMetrics([]);
    assert.deepEqual(aggregate, {
      count: 0,
      availabilityPercent: null,
      peakMemoryPercent: null,
      peakCpuPercent: null,
      diskFreePercent: null,
      avgLatencyMs: null,
      maxRequests: null,
    });
    assert.match(formatReport(aggregate), /Данных для отчёта пока нет/);
  });

  it('частичные данные → отдельные null и прочерки в отчёте', () => {
    const aggregate = aggregateMetrics([run({ memoryUsedPercent: 50 })]);
    assert.equal(aggregate.availabilityPercent, null);
    assert.equal(aggregate.avgLatencyMs, null);
    assert.equal(aggregate.diskFreePercent, null);
    assert.equal(aggregate.peakCpuPercent, null);
    assert.equal(aggregate.peakMemoryPercent, 50);
    const report = formatReport(aggregate);
    assert.match(report, /доступность: —/);
    assert.match(report, /пик памяти: 50%/);
    assert.match(report, /1 замер/);
  });
});
