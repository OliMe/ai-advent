import { homedir } from 'node:os';
import { join } from 'node:path';

/** Конфигурация сервера планировщика из переменных окружения. */
export interface SchedulerConfig {
  /** Путь к JSON-файлу состояния (задачи + история). */
  storePath: string;
  /** Период фонового тика, мс. */
  tickIntervalMs: number;
  /** Порт HTTP-режима. */
  port: number;
}

const DEFAULT_TICK_INTERVAL_MS = 15_000;
const DEFAULT_PORT = 3000;

/** Целое не меньше 1 из env или значение по умолчанию. */
function parsePositiveInteger(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 ? value : fallback;
}

/** Собирает конфигурацию планировщика из переменных окружения. */
export function loadSchedulerConfig(env: NodeJS.ProcessEnv): SchedulerConfig {
  return {
    storePath: env.SCHEDULER_STORE_PATH?.trim() || join(homedir(), '.scheduler-mcp', 'state.json'),
    tickIntervalMs: parsePositiveInteger(env.SCHEDULER_TICK_MS, DEFAULT_TICK_INTERVAL_MS),
    port: parsePositiveInteger(env.PORT, DEFAULT_PORT),
  };
}
