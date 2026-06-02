import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config.ts';

const ENV_KEYS = [
  'LLM_API_KEY',
  'LLM_BASE_URL',
  'LLM_MODEL',
  'LLM_TEMPERATURE',
  'LLM_SYSTEM_PROMPT',
  'LLM_REQUEST_TIMEOUT_MS',
];

describe('loadConfig', () => {
  let savedEnv: Record<string, string | undefined>;
  let savedCwd: string;
  let workDir: string;

  beforeEach(() => {
    // Сохраняем окружение и переходим в чистый каталог без .env,
    // чтобы process.loadEnvFile не подтянул переменные проекта.
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    savedCwd = process.cwd();
    workDir = mkdtempSync(join(tmpdir(), 'llm-config-'));
    process.chdir(workDir);
  });

  afterEach(() => {
    process.chdir(savedCwd);
    rmSync(workDir, { recursive: true, force: true });
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it('бросает ошибку, если не задан LLM_API_KEY', () => {
    assert.throws(() => loadConfig(), /LLM_API_KEY/);
  });

  it('бросает ошибку, если не задан LLM_BASE_URL', () => {
    process.env.LLM_API_KEY = 'k';
    assert.throws(() => loadConfig(), /LLM_BASE_URL/);
  });

  it('бросает ошибку, если не задан LLM_MODEL', () => {
    process.env.LLM_API_KEY = 'k';
    process.env.LLM_BASE_URL = 'https://api.test/v1';
    assert.throws(() => loadConfig(), /LLM_MODEL/);
  });

  it('возвращает значения по умолчанию для необязательных переменных', () => {
    process.env.LLM_API_KEY = 'k';
    process.env.LLM_BASE_URL = 'https://api.test/v1';
    process.env.LLM_MODEL = 'm';

    const config = loadConfig();

    assert.equal(config.apiKey, 'k');
    assert.equal(config.baseUrl, 'https://api.test/v1');
    assert.equal(config.model, 'm');
    assert.equal(config.temperature, 0.7);
    assert.equal(config.requestTimeoutMs, 60_000);
    assert.match(config.systemPrompt, /ассистент/i);
  });

  it('читает корректную температуру и системный промпт', () => {
    process.env.LLM_API_KEY = 'k';
    process.env.LLM_BASE_URL = 'https://api.test/v1';
    process.env.LLM_MODEL = 'm';
    process.env.LLM_TEMPERATURE = '0.2';
    process.env.LLM_SYSTEM_PROMPT = 'Особый промпт';

    const config = loadConfig();

    assert.equal(config.temperature, 0.2);
    assert.equal(config.systemPrompt, 'Особый промпт');
  });

  it('откатывается к температуре по умолчанию при нечисловом значении', () => {
    process.env.LLM_API_KEY = 'k';
    process.env.LLM_BASE_URL = 'https://api.test/v1';
    process.env.LLM_MODEL = 'm';
    process.env.LLM_TEMPERATURE = 'не-число';

    assert.equal(loadConfig().temperature, 0.7);
  });

  it('читает корректный таймаут', () => {
    process.env.LLM_API_KEY = 'k';
    process.env.LLM_BASE_URL = 'https://api.test/v1';
    process.env.LLM_MODEL = 'm';
    process.env.LLM_REQUEST_TIMEOUT_MS = '120000';

    assert.equal(loadConfig().requestTimeoutMs, 120_000);
  });

  it('откатывается к таймауту по умолчанию при нечисловом значении', () => {
    process.env.LLM_API_KEY = 'k';
    process.env.LLM_BASE_URL = 'https://api.test/v1';
    process.env.LLM_MODEL = 'm';
    process.env.LLM_REQUEST_TIMEOUT_MS = 'abc';

    assert.equal(loadConfig().requestTimeoutMs, 60_000);
  });

  it('откатывается к таймауту по умолчанию при неположительном значении', () => {
    process.env.LLM_API_KEY = 'k';
    process.env.LLM_BASE_URL = 'https://api.test/v1';
    process.env.LLM_MODEL = 'm';
    process.env.LLM_REQUEST_TIMEOUT_MS = '0';

    assert.equal(loadConfig().requestTimeoutMs, 60_000);
  });

  it('подгружает переменные из файла .env в текущем каталоге', () => {
    writeFileSync(
      join(workDir, '.env'),
      'LLM_API_KEY=from_file\nLLM_BASE_URL=https://file.test/v1\nLLM_MODEL=file-model\n',
    );

    const config = loadConfig();

    assert.equal(config.apiKey, 'from_file');
    assert.equal(config.baseUrl, 'https://file.test/v1');
    assert.equal(config.model, 'file-model');
  });
});
