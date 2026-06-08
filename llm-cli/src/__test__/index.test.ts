import { describe, it, beforeEach, afterEach } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as readline from 'node:readline/promises';
import { PassThrough, Writable } from 'node:stream';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  askModel,
  runOnce,
  runInteractive,
  describeError,
  main,
  reportFatalError,
  parseArgs,
  augmentSystemPrompt,
  validTemperature,
  estimateTokens,
  historyBudgetTokens,
  trimHistoryToBudget,
} from '../index.ts';
import { ChatCompletionClient } from '../../../core/src/index.ts';
import type { AppConfig, ChatMessage } from '../../../core/src/index.ts';
import { makeConfig, completionResponse } from '../../../core/src/__test__/helpers.ts';

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
  temperature = 0.7,
  config: AppConfig = makeConfig(),
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
  const finished = runInteractive(
    client,
    config,
    {},
    false,
    temperature,
    input,
    output,
    readline.createInterface,
  );
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
  it('передаёт клиенту AbortSignal, ограничения и disableThinking, возвращает ответ', async t => {
    let capturedOptions: Parameters<ChatCompletionClient['complete']>[1];
    const client = clientWith(t, async (_messages, options) => {
      capturedOptions = options;
      return 'ответ';
    });

    const result = await askModel(
      client,
      [{ role: 'user', content: 'x' }],
      5000,
      { maxTokens: 50, stop: ['END'], responseFormat: { type: 'json_object' } },
      true,
      0.3,
    );

    assert.equal(result, 'ответ');
    assert.ok(capturedOptions?.signal instanceof AbortSignal);
    assert.equal(capturedOptions?.maxTokens, 50);
    assert.deepEqual(capturedOptions?.stop, ['END']);
    assert.deepEqual(capturedOptions?.responseFormat, { type: 'json_object' });
    assert.equal(capturedOptions?.disableThinking, true);
    assert.equal(capturedOptions?.temperature, 0.3);
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

    await runOnce(client, makeConfig(), 'привет', {}, false, 0.7, output.stream);

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

    const finished = runInteractive(
      client,
      makeConfig(),
      {},
      false,
      0.7,
      input,
      output.stream,
      () => {
        captured = readline.createInterface({ input, output: output.stream });
        return captured;
      },
    );

    await delay(20);
    captured?.emit('SIGINT');
    await finished;

    assert.match(output.text(), /До встречи!/);
  });

  it('меняет температуру командой /temp и применяет её к следующему запросу', async t => {
    let capturedTemperature: number | undefined;
    const client = clientWith(t, async (_messages, options) => {
      capturedTemperature = options?.temperature;
      return 'ОТВЕТ';
    });

    const { finished, text } = driveInteractive(client, ['/temp 0.2', 'привет', '/exit']);
    await finished;

    assert.match(text(), /Температура установлена: 0.2/);
    assert.equal(capturedTemperature, 0.2);
  });

  it('сообщает о некорректной температуре в /temp', async t => {
    const client = clientWith(t, async () => 'ОТВЕТ');

    const { finished, text } = driveInteractive(client, ['/temp abc', '/exit']);
    await finished;

    assert.match(text(), /Некорректная температура/);
  });

  it('обрезает историю скользящим окном по бюджету токенов', async t => {
    const sentBatches: ChatMessage[][] = [];
    const client = clientWith(t, async messages => {
      sentBatches.push(messages as ChatMessage[]);
      return 'короткий ответ';
    });
    // Крошечный контекст: старый длинный ход не помещается в окно следующего хода.
    const config = makeConfig({ contextTokens: 300 });
    const firstQuestion = 'ПЕРВЫЙ ' + 'а'.repeat(3000);

    const { finished } = driveInteractive(
      client,
      [firstQuestion, 'второй вопрос', '/exit'],
      0.7,
      config,
    );
    await finished;

    const lastSent = sentBatches[sentBatches.length - 1];
    assert.equal(lastSent[0].role, 'system'); // системное сообщение сохраняется
    assert.ok(lastSent.some(message => message.content === 'второй вопрос')); // свежий ход на месте
    assert.ok(!lastSent.some(message => message.content.includes('ПЕРВЫЙ'))); // старый ход выпал
  });
});

describe('estimateTokens', () => {
  it('оценивает число токенов как ceil(длина / 3)', () => {
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens('абвгде'), 2);
    assert.equal(estimateTokens('абвг'), 2); // ceil(4/3)
  });
});

describe('historyBudgetTokens', () => {
  it('вычитает явный резерв под ответ из контекста', () => {
    assert.equal(historyBudgetTokens(8192, 1000), 7192);
  });

  it('при отсутствии --max-tokens вычитает дефолтный резерв', () => {
    assert.equal(historyBudgetTokens(8192), 8192 - 1024);
  });

  it('не опускается ниже минимума', () => {
    assert.equal(historyBudgetTokens(100), 256);
  });
});

describe('trimHistoryToBudget', () => {
  const system: ChatMessage = { role: 'system', content: 'сис' };
  const turn = (role: ChatMessage['role'], n: number): ChatMessage => ({
    role,
    content: `${role}-${n} ${'x'.repeat(60)}`,
  });

  it('сохраняет всё, когда укладывается в бюджет', () => {
    const history = [system, turn('user', 1), turn('assistant', 1)];
    assert.deepEqual(trimHistoryToBudget(history, 10_000), history);
  });

  it('сохраняет систему и свежие реплики, отбрасывая старые', () => {
    const history = [system, turn('user', 1), turn('assistant', 1), turn('user', 2)];
    const result = trimHistoryToBudget(history, 60);

    assert.equal(result[0], system); // система всегда первая
    assert.ok(result.some(message => message.content.startsWith('user-2'))); // свежий ход
    assert.ok(!result.some(message => message.content.startsWith('user-1'))); // старый выпал
  });

  it('сохраняет последнее сообщение, даже если оно превышает бюджет', () => {
    const history = [system, turn('user', 1)];
    const result = trimHistoryToBudget(history, 1);

    assert.equal(result.length, 2); // система + последний ход
    assert.ok(result.some(message => message.content.startsWith('user-1')));
  });
});

describe('validTemperature', () => {
  it('принимает конечное неотрицательное число', () => {
    assert.equal(validTemperature('0.4'), 0.4);
    assert.equal(validTemperature('1.5'), 1.5);
  });

  it('отвергает отрицательные значения и нечисла', () => {
    assert.equal(validTemperature('-1'), null);
    assert.equal(validTemperature('abc'), null);
  });
});

describe('augmentSystemPrompt', () => {
  it('дописывает схему в промпт при json_schema', () => {
    const schema = { type: 'object', properties: { city: { type: 'string' } } };
    const result = augmentSystemPrompt('Базовый промпт.', {
      responseFormat: { type: 'json_schema', json_schema: { name: 'response', schema } },
    });

    assert.match(result, /^Базовый промпт\./);
    assert.match(result, /строго в виде JSON/);
    assert.match(result, /"city"/);
  });

  it('не меняет промпт при json_object', () => {
    const result = augmentSystemPrompt('Базовый промпт.', {
      responseFormat: { type: 'json_object' },
    });
    assert.equal(result, 'Базовый промпт.');
  });

  it('не меняет промпт без ограничения формата', () => {
    assert.equal(augmentSystemPrompt('Базовый промпт.', {}), 'Базовый промпт.');
  });
});

describe('parseArgs', () => {
  it('без флагов собирает промпт из слов, ограничений нет', () => {
    const result = parseArgs(['привет', 'мир']);
    assert.equal(result.prompt, 'привет мир');
    assert.deepEqual(result.limits, {});
    assert.equal(result.disableThinking, false);
    assert.equal(result.temperature, undefined);
  });

  it('--temperature принимает число (= и пробел)', () => {
    assert.equal(parseArgs(['--temperature=0.2']).temperature, 0.2);
    assert.equal(parseArgs(['--temperature', '1.5']).temperature, 1.5);
  });

  it('бросает ошибку при невалидной --temperature', () => {
    assert.throws(() => parseArgs(['--temperature=-1']), /неотрицательное число/);
    assert.throws(() => parseArgs(['--temperature=abc']), /неотрицательное число/);
  });

  it('--no-thinking включает отключение рассуждений', () => {
    const result = parseArgs(['--no-thinking', 'привет']);
    assert.equal(result.prompt, 'привет');
    assert.equal(result.disableThinking, true);
  });

  it('--json включает формат json_object', () => {
    const result = parseArgs(['--json', 'дай', 'json']);
    assert.equal(result.prompt, 'дай json');
    assert.deepEqual(result.limits.responseFormat, { type: 'json_object' });
  });

  it('--max-tokens принимает значение через = и через пробел', () => {
    assert.equal(parseArgs(['--max-tokens=200']).limits.maxTokens, 200);
    assert.equal(parseArgs(['--max-tokens', '300']).limits.maxTokens, 300);
  });

  it('единственный --stop даёт строку, несколько — массив', () => {
    assert.equal(parseArgs(['--stop', '###']).limits.stop, '###');
    assert.deepEqual(parseArgs(['--stop', 'A', '--stop=B']).limits.stop, ['A', 'B']);
  });

  it('бросает ошибку при невалидном --max-tokens', () => {
    assert.throws(() => parseArgs(['--max-tokens=0']), /положительное целое/);
    assert.throws(() => parseArgs(['--max-tokens=abc']), /положительное целое/);
  });

  it('--context-tokens принимает значение через = и через пробел', () => {
    assert.equal(parseArgs(['--context-tokens=4096']).contextTokens, 4096);
    assert.equal(parseArgs(['--context-tokens', '8192']).contextTokens, 8192);
  });

  it('бросает ошибку при невалидном --context-tokens', () => {
    assert.throws(() => parseArgs(['--context-tokens=0']), /положительное целое/);
    assert.throws(() => parseArgs(['--context-tokens=abc']), /положительное целое/);
  });

  it('бросает ошибку, если у флага нет значения', () => {
    assert.throws(() => parseArgs(['--max-tokens']), /Не указано значение/);
  });

  it('бросает ошибку на неизвестном флаге', () => {
    assert.throws(() => parseArgs(['--unknown=1']), /Неизвестный флаг/);
  });

  it('--json-schema читает файл и строит строгий response_format', () => {
    const dir = mkdtempSync(join(tmpdir(), 'llm-schema-'));
    try {
      const file = join(dir, 'schema.json');
      const schema = { type: 'object', properties: { city: { type: 'string' } } };
      writeFileSync(file, JSON.stringify(schema));

      const { limits } = parseArgs([`--json-schema=${file}`]);

      assert.deepEqual(limits.responseFormat, {
        type: 'json_schema',
        json_schema: { name: 'response', strict: true, schema },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--json-schema бросает ошибку, если файл не найден', () => {
    assert.throws(
      () => parseArgs(['--json-schema=/нет/такого/файла.json']),
      /прочитать файл схемы/,
    );
  });

  it('--json-schema бросает ошибку при невалидном JSON в файле', () => {
    const dir = mkdtempSync(join(tmpdir(), 'llm-schema-'));
    try {
      const file = join(dir, 'bad.json');
      writeFileSync(file, '{ не json');
      assert.throws(() => parseArgs([`--json-schema=${file}`]), /Невалидный JSON/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it('принимает флаг --context-tokens в интерактивном режиме', async () => {
    const input = new PassThrough();
    const output = makeCollector();

    const finished = main(['node', 'cli.ts', '--context-tokens=500'], input, output.stream);
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
