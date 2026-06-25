import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadSchedulerConfig } from '../index.ts';

const env = (values: Record<string, string | undefined>): NodeJS.ProcessEnv =>
  values as NodeJS.ProcessEnv;

describe('loadSchedulerConfig', () => {
  it('значения по умолчанию при пустом окружении', () => {
    const config = loadSchedulerConfig(env({}));
    assert.equal(config.storePath, join(homedir(), '.scheduler-mcp', 'state.json'));
    assert.equal(config.tickIntervalMs, 15_000);
    assert.equal(config.port, 3000);
  });

  it('берёт значения из окружения', () => {
    const config = loadSchedulerConfig(
      env({ SCHEDULER_STORE_PATH: '/tmp/s.json', SCHEDULER_TICK_MS: '5000', PORT: '8080' }),
    );
    assert.equal(config.storePath, '/tmp/s.json');
    assert.equal(config.tickIntervalMs, 5000);
    assert.equal(config.port, 8080);
  });

  it('пустой/некорректный ввод откатывается к значениям по умолчанию', () => {
    const config = loadSchedulerConfig(
      env({ SCHEDULER_STORE_PATH: '   ', SCHEDULER_TICK_MS: '0', PORT: 'abc' }),
    );
    assert.equal(config.storePath, join(homedir(), '.scheduler-mcp', 'state.json'));
    assert.equal(config.tickIntervalMs, 15_000); // 0 < 1 → дефолт
    assert.equal(config.port, 3000); // NaN → дефолт
  });
});
