import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CpuIdleTracker,
  parseCpuTotals,
  parseLoadAverage,
  parseMemoryAvailableRatio,
  readSystemMetrics,
} from '../system-metrics.ts';

const PROC_STAT = ['cpu  100 0 100 700 100 0 0 0 0 0', 'cpu0 50 0 50 350 50 0 0 0 0 0'].join('\n');

const PROC_MEMINFO = ['MemTotal:        6062664 kB', 'MemAvailable:    3031332 kB'].join('\n');

test('parseCpuTotals: простой считается как idle + iowait', () => {
  const totals = parseCpuTotals(PROC_STAT);
  assert.equal(totals.idle, 800);
  assert.equal(totals.total, 1000);
});

test('parseCpuTotals: без суммарной строки — ошибка', () => {
  assert.throws(() => parseCpuTotals('intr 1 2 3'), /нет суммарной строки/);
});

test('parseMemoryAvailableRatio: доля доступной памяти', () => {
  assert.equal(parseMemoryAvailableRatio(PROC_MEMINFO), 0.5);
});

test('parseMemoryAvailableRatio: нет поля — ошибка', () => {
  assert.throws(() => parseMemoryAvailableRatio('MemTotal: 100 kB'), /нет поля «MemAvailable»/);
});

test('parseLoadAverage: берётся первое число', () => {
  assert.equal(parseLoadAverage('0.71 1.25 1.69 5/284 518498\n'), 0.71);
});

test('CpuIdleTracker: первый замер — средний простой с загрузки системы', () => {
  const tracker = new CpuIdleTracker();
  assert.equal(tracker.sample(PROC_STAT), 80);
});

test('CpuIdleTracker: второй замер считает дельту', () => {
  const tracker = new CpuIdleTracker();
  tracker.sample(PROC_STAT);
  const next = 'cpu  200 0 200 800 100 0 0 0 0 0';
  // прирост: idle+iowait 900-800 = 100, всего 1300-1000 = 300 → простой ~33%
  assert.equal(Math.round(tracker.sample(next)), 33);
});

test('CpuIdleTracker: счётчики не сдвинулись — считаем узел простаивающим', () => {
  const tracker = new CpuIdleTracker();
  tracker.sample(PROC_STAT);
  assert.equal(tracker.sample(PROC_STAT), 100);
});

test('readSystemMetrics: собирает снимок из трёх файлов', () => {
  const source = {
    readStat: () => PROC_STAT,
    readMemInfo: () => PROC_MEMINFO,
    readLoadAverage: () => '1.50 1.00 0.50 1/100 200',
  };
  const metrics = readSystemMetrics(source, new CpuIdleTracker());
  assert.equal(metrics.cpuIdlePercent, 80);
  assert.equal(metrics.loadAverage1m, 1.5);
  assert.equal(metrics.memoryAvailableRatio, 0.5);
});
