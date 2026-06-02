import { describe, it, beforeEach, afterEach } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as readline from 'node:readline/promises';
import { PassThrough, Writable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  askModel,
  runOnce,
  runInteractive,
  describeError,
  main,
  reportFatalError,
} from '../index.ts';
import { ChatCompletionClient } from '../chat-completion-client.ts';
import { makeConfig, completionResponse } from './helpers.ts';

/** Поток-приёмник: накапливает записанный текст. */
function makeCollector(): { stream: Writable; text: () => string } {
  let buffer = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      buffer += chunk.toString();
      callback();
    },
  });
  return { stream, text: () => buffer };
}

/** Небольшая пауза, чтобы дать промисам/слушателям прокрутиться. */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Прогоняет интерактивный режим, подавая очередную строку в ответ на приглашение
 * «Вы: ». Это детерминированно: readline получает ровно одну строку на вопрос
 * (если писать пачкой, лишние события 'line' теряются между вопросами).
 */
function driveInteractive(
  client: ChatCompletionClient,
  lines: string[],
): { finished: Promise<void>; text: () => string } {
  const input = new PassThrough();
  let buffer = '';
  let next = 0;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      const text = chunk.toString();
      buffer += text;
      if (text.includes('Вы: ') && next < lines.length) {
        const line = lines[next++];
        // setImmediate — чтобы question успел повесить слушатель строки.
        setImmediate(() => input.write(line + '\n'));
      }
      callback();
    },
  });
  const finished = runInteractive(client, makeConfig(), input, output, readline.createInterface);
  return { finished, text: () => buffer };
}

/** Клиент с подменённым методом complete. */
function clientWith(
  t: TestContext,
  complete: ChatCompletionClient['complete'],
): ChatCompletionClient {
  const client = new ChatCompletionClient(makeConfig());
  t.mock.method(client, 'complete', complete);
  return client;
}

describe('describeError', () => {
  it('распознаёт таймаут по имени TimeoutError', () => {
    const error = new Error('timed out');
    error.name = 'TimeoutError';
    assert.equal(describeError(error), 'превышено время ожидания ответа от API.');
  });

  it('возвращает message для обычной ошибки', () => {
    assert.equal(describeError(new Error('что-то пошло не так')), 'что-то пошло не так');
  });

  it('приводит не-Error к строке', () => {
    assert.equal(describeError('просто строка'), 'просто строка');
  });
});

describe('askModel', () => {
  it('передаёт клиенту AbortSignal и возвращает ответ', async t => {
    let capturedSignal: AbortSignal | undefined;
    const client = clientWith(t, async (_messages, options) => {
      capturedSignal = options?.signal;
      return 'ответ';
    });

    const result = await askModel(client, [{ role: 'user', content: 'x' }], 5000);

    assert.equal(result, 'ответ');
    assert.ok(capturedSignal instanceof AbortSignal);
  });
});

describe('runOnce', () => {
  it('пишет ответ модели в вывод с переводом строки', async t => {
    const calls: unknown[] = [];
    const client = clientWith(t, async messages => {
      calls.push(messages);
      return 'единственный ответ';
    });
    const output = makeCollector();

    await runOnce(client, makeConfig(), 'привет', output.stream);

    assert.equal(output.text(), 'единственный ответ\n');
    assert.deepEqual(calls[0], [
      { role: 'system', content: 'Ты — ассистент.' },
      { role: 'user', content: 'привет' },
    ]);
  });
});

describe('runInteractive', () => {
  it('ведёт диалог, пропускает пустой ввод и выходит по /quit', async t => {
    const client = clientWith(t, async () => 'ОТВЕТ');

    const { finished, text } = driveInteractive(client, ['Привет', '', '/quit']);
    await finished;

    assert.match(text(), /Чат с моделью «test-model»/);
    assert.match(text(), /Ассистент: ОТВЕТ/);
    assert.match(text(), /До встречи!/);
  });

  it('печатает ошибку и откатывает ход, затем выходит по /exit', async t => {
    const client = clientWith(t, async () => {
      throw new Error('сбой API');
    });

    const { finished, text } = driveInteractive(client, ['вопрос', '/exit']);
    await finished;

    assert.match(text(), /\[ошибка\] сбой API/);
    assert.match(text(), /До встречи!/);
  });

  it('выходит штатно при Ctrl+C (SIGINT закрывает интерфейс)', async t => {
    const client = clientWith(t, async () => 'не-важно');
    const input = new PassThrough();
    const output = makeCollector();
    let captured: readline.Interface | undefined;

    const finished = runInteractive(client, makeConfig(), input, output.stream, () => {
      captured = readline.createInterface({ input, output: output.stream });
      return captured;
    });

    await delay(20);
    captured?.emit('SIGINT');
    await finished;

    assert.match(output.text(), /До встречи!/);
  });
});

describe('main', () => {
  const ENV_KEYS = ['LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL'];
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

  it('режим одного запроса при наличии промпта в аргументах', async t => {
    t.mock.method(globalThis, 'fetch', (async () =>
      completionResponse('ответ из main')) as unknown as typeof fetch);
    const output = makeCollector();

    await main(['node', 'cli.ts', 'скажи', 'привет'], new PassThrough(), output.stream);

    assert.match(output.text(), /ответ из main/);
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
});

describe('reportFatalError', () => {
  it('печатает ошибку и выставляет код выхода 1', t => {
    const messages: string[] = [];
    t.mock.method(console, 'error', (message: string) => {
      messages.push(message);
    });
    const savedExitCode = process.exitCode;
    try {
      reportFatalError(new Error('фатальная ошибка'));
      assert.match(messages[0], /Ошибка: фатальная ошибка/);
      assert.equal(process.exitCode, 1);
    } finally {
      process.exitCode = savedExitCode;
    }
  });
});
