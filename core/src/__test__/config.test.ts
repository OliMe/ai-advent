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
  'LLM_MAX_RETRIES',
  'LLM_RETRY_BASE_MS',
  'LLM_CONTEXT_TOKENS',
  'LLM_PRICE_INPUT_PER_1M',
  'LLM_PRICE_OUTPUT_PER_1M',
  'LLM_USD_RUB',
  'LLM_STAGE_MAX_TOKENS',
  'LLM_MAX_STAGE_AGENTS',
  'LLM_STAGE_AGENT_CONCURRENCY',
  'LLM_MAX_TOOL_ROUNDS',
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
    assert.equal(config.maxRetries, 3);
    assert.equal(config.retryBaseMs, 500);
    assert.equal(config.contextTokens, 8192);
    assert.equal(config.priceInputPer1M, 0);
    assert.equal(config.priceOutputPer1M, 0);
    assert.equal(config.usdToRub, 90);
    assert.equal(config.maxStageAgents, 4); // дефолт: команда до 4 агентов на этап
    assert.equal(config.stageAgentConcurrency, 2);
    assert.equal(config.maxToolRounds, 20); // дефолт: до 20 раундов агентного цикла
    assert.match(config.systemPrompt, /ассистент/i);
  });

  it('читает потолок и конкурентность команды агентов + лимит раундов инструментов', () => {
    process.env.LLM_API_KEY = 'k';
    process.env.LLM_BASE_URL = 'https://api.test/v1';
    process.env.LLM_MODEL = 'm';
    process.env.LLM_MAX_STAGE_AGENTS = '6';
    process.env.LLM_STAGE_AGENT_CONCURRENCY = '3';
    process.env.LLM_MAX_TOOL_ROUNDS = '30';

    const config = loadConfig();

    assert.equal(config.maxStageAgents, 6);
    assert.equal(config.stageAgentConcurrency, 3);
    assert.equal(config.maxToolRounds, 30);
  });

  it('откатывается к дефолтам команды агентов при невалидных значениях', () => {
    process.env.LLM_API_KEY = 'k';
    process.env.LLM_BASE_URL = 'https://api.test/v1';
    process.env.LLM_MODEL = 'm';
    process.env.LLM_MAX_STAGE_AGENTS = '0'; // меньше 1 — недопустимо
    process.env.LLM_STAGE_AGENT_CONCURRENCY = 'не-число';

    const config = loadConfig();

    assert.equal(config.maxStageAgents, 4);
    assert.equal(config.stageAgentConcurrency, 2);
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

  it('читает размер контекста', () => {
    process.env.LLM_API_KEY = 'k';
    process.env.LLM_BASE_URL = 'https://api.test/v1';
    process.env.LLM_MODEL = 'm';
    process.env.LLM_CONTEXT_TOKENS = '32768';

    assert.equal(loadConfig().contextTokens, 32768);
  });

  it('откатывается к размеру контекста по умолчанию при невалидном значении', () => {
    process.env.LLM_API_KEY = 'k';
    process.env.LLM_BASE_URL = 'https://api.test/v1';
    process.env.LLM_MODEL = 'm';
    process.env.LLM_CONTEXT_TOKENS = '0';

    assert.equal(loadConfig().contextTokens, 8192);
  });

  it('читает тарифы и курс', () => {
    process.env.LLM_API_KEY = 'k';
    process.env.LLM_BASE_URL = 'https://api.test/v1';
    process.env.LLM_MODEL = 'm';
    process.env.LLM_PRICE_INPUT_PER_1M = '0.6';
    process.env.LLM_PRICE_OUTPUT_PER_1M = '2.2';
    process.env.LLM_USD_RUB = '100';

    const config = loadConfig();
    assert.equal(config.priceInputPer1M, 0.6);
    assert.equal(config.priceOutputPer1M, 2.2);
    assert.equal(config.usdToRub, 100);
  });

  it('откатывается к дефолтам при невалидных тарифах и курсе', () => {
    process.env.LLM_API_KEY = 'k';
    process.env.LLM_BASE_URL = 'https://api.test/v1';
    process.env.LLM_MODEL = 'm';
    process.env.LLM_PRICE_INPUT_PER_1M = '-1';
    process.env.LLM_PRICE_OUTPUT_PER_1M = 'abc';
    process.env.LLM_USD_RUB = '0';

    const config = loadConfig();
    assert.equal(config.priceInputPer1M, 0);
    assert.equal(config.priceOutputPer1M, 0);
    assert.equal(config.usdToRub, 90);
  });

  it('читает число повторов и базовую задержку', () => {
    process.env.LLM_API_KEY = 'k';
    process.env.LLM_BASE_URL = 'https://api.test/v1';
    process.env.LLM_MODEL = 'm';
    process.env.LLM_MAX_RETRIES = '5';
    process.env.LLM_RETRY_BASE_MS = '250';

    const config = loadConfig();
    assert.equal(config.maxRetries, 5);
    assert.equal(config.retryBaseMs, 250);
  });

  it('допускает ноль повторов', () => {
    process.env.LLM_API_KEY = 'k';
    process.env.LLM_BASE_URL = 'https://api.test/v1';
    process.env.LLM_MODEL = 'm';
    process.env.LLM_MAX_RETRIES = '0';

    assert.equal(loadConfig().maxRetries, 0);
  });

  it('откатывается к дефолтам при невалидных значениях ретраев', () => {
    process.env.LLM_API_KEY = 'k';
    process.env.LLM_BASE_URL = 'https://api.test/v1';
    process.env.LLM_MODEL = 'm';
    process.env.LLM_MAX_RETRIES = '-1';
    process.env.LLM_RETRY_BASE_MS = 'abc';

    const config = loadConfig();
    assert.equal(config.maxRetries, 3);
    assert.equal(config.retryBaseMs, 500);
  });

  it('читает потолок генерации этапов: валидный — задан, иначе — отсутствует', () => {
    process.env.LLM_API_KEY = 'k';
    process.env.LLM_BASE_URL = 'https://api.test/v1';
    process.env.LLM_MODEL = 'm';

    assert.equal(loadConfig().stageMaxTokens, undefined); // не задан

    process.env.LLM_STAGE_MAX_TOKENS = '2048';
    assert.equal(loadConfig().stageMaxTokens, 2048); // валидный

    process.env.LLM_STAGE_MAX_TOKENS = '-5';
    assert.equal(loadConfig().stageMaxTokens, undefined); // невалидный → отсутствует
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
