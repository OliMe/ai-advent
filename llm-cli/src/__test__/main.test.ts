import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../index.ts';
import { makeCollector } from './helpers.ts';
import { completionResponse, streamResponse } from '../../../core/src/__test__/helpers.ts';
import type { ChatMessage } from '../../../core/src/index.ts';

describe('main', () => {
  const ENV_KEYS = ['LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL', 'LLM_SESSION_DIR'];
  let savedEnv: Record<string, string | undefined>;
  let savedCwd: string;
  let workDir: string;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
    }
    process.env.LLM_API_KEY = 'k';
    process.env.LLM_BASE_URL = 'https://api.test/v1';
    process.env.LLM_MODEL = 'test-model';
    savedCwd = process.cwd();
    workDir = mkdtempSync(join(tmpdir(), 'llm-main-'));
    // Сессии — во временный каталог, чтобы не трогать ~/.llm-cli.
    process.env.LLM_SESSION_DIR = join(workDir, 'sessions');
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

  it('режим одного запроса при наличии промпта в аргументах (стрим)', async t => {
    t.mock.method(globalThis, 'fetch', (async () =>
      streamResponse([
        'data: {"choices":[{"delta":{"content":"ответ из main"}}]}\n',
        'data: [DONE]\n',
      ])) as unknown as typeof fetch);
    const output = makeCollector();

    await main(['node', 'cli.ts', 'скажи', 'привет'], new PassThrough(), output.stream);

    assert.match(output.text(), /ответ из main/);
  });

  it('режим одного запроса с --no-stream использует обычный ответ', async t => {
    t.mock.method(globalThis, 'fetch', (async () =>
      completionResponse('ответ без стрима')) as unknown as typeof fetch);
    const output = makeCollector();

    await main(
      ['node', 'cli.ts', '--no-stream', 'скажи', 'привет'],
      new PassThrough(),
      output.stream,
    );

    assert.match(output.text(), /ответ без стрима/);
  });

  it('режим одного запроса с --file включает содержимое файла в запрос', async t => {
    const path = join(workDir, 'data.txt');
    writeFileSync(path, 'ДАННЫЕ ИЗ ФАЙЛА');
    let captured: { messages: ChatMessage[] } | undefined;
    t.mock.method(globalThis, 'fetch', (async (_url: string, init: RequestInit) => {
      captured = JSON.parse(String(init.body));
      return completionResponse('ответ');
    }) as unknown as typeof fetch);
    const output = makeCollector();

    await main(
      ['node', 'cli.ts', '--no-stream', '--file', path, 'обработай'],
      new PassThrough(),
      output.stream,
    );

    const userMessage = captured?.messages.find(message => message.role === 'user');
    assert.match(userMessage?.content ?? '', /ДАННЫЕ ИЗ ФАЙЛА/);
    assert.match(userMessage?.content ?? '', /обработай/);
  });

  it('интерактивный режим при отсутствии промпта', async () => {
    const input = new PassThrough();
    const output = makeCollector();

    const finished = main(['node', 'cli.ts'], input, output.stream);
    input.write('/exit\n');
    await finished;

    assert.match(output.text(), /Чат с моделью/);
    assert.match(output.text(), /До встречи!/);
  });

  it('принимает флаг --context-tokens в интерактивном режиме', async () => {
    const input = new PassThrough();
    const output = makeCollector();

    const finished = main(['node', 'cli.ts', '--context-tokens=500'], input, output.stream);
    input.write('/exit\n');
    await finished;

    assert.match(output.text(), /Чат с моделью/);
    assert.match(output.text(), /До встречи!/);
  });

  it('интерактивный режим с --ephemeral (без хранилища сессий)', async () => {
    const input = new PassThrough();
    const output = makeCollector();

    const finished = main(['node', 'cli.ts', '--ephemeral'], input, output.stream);
    input.write('/exit\n');
    await finished;

    assert.match(output.text(), /Чат с моделью/);
    assert.match(output.text(), /До встречи!/);
  });

  it('--profile фиксирует активный профиль в хранилище', async () => {
    const input = new PassThrough();
    const output = makeCollector();

    const finished = main(['node', 'cli.ts', '--profile', 'работа'], input, output.stream);
    input.write('/exit\n');
    await finished;

    assert.match(output.text(), /До встречи!/);
    const active = readFileSync(join(workDir, 'profiles', '.active'), 'utf8');
    assert.equal(active, 'работа'); // указатель активного профиля сохранён
  });
});
