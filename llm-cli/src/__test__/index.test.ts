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
  historyTokens,
  requestCostUsd,
  formatUsageStats,
  formatSessionTotals,
  createSpinner,
  streamAnswer,
  sessionDirectory,
  resolveSession,
  newSession,
  helpText,
  formatSessionList,
  formatAttachment,
  attachFiles,
  combinePrompt,
  createMemoryStrategy,
  layerBudgets,
  MemoryManager,
  formatTaskList,
  formatCurrentTask,
  formatProfile,
  profilePath,
  tasksDirectory,
  type MemoryKind,
  type MemorySettings,
} from '../index.ts';
import {
  ChatCompletionClient,
  createSession,
  summarize,
  summarizeTask,
  emptyProfile,
  createTask,
} from '../../../core/src/index.ts';
import type {
  AppConfig,
  ChatMessage,
  CompleteOptions,
  CompletionResult,
  StreamDelta,
  Profile,
  Session,
  SessionStore,
  Task,
  TaskStore,
  TaskSummary,
  Usage,
} from '../../../core/src/index.ts';
import {
  makeConfig,
  completionResponse,
  streamResponse,
} from '../../../core/src/__test__/helpers.ts';

/** Сессия с системным сообщением из конфига (для интерактивных тестов). */
function makeSession(config: AppConfig = makeConfig()): Session {
  return createSession(config.model, [{ role: 'system', content: config.systemPrompt }]);
}

/** Сохранённая сессия с заданным id (для /switch и /branch). */
function storedSession(id: string): Session {
  return {
    version: 1,
    id,
    model: 'm',
    createdAt: '2026-06-10T10:00:00.000Z',
    updatedAt: '2026-06-10T10:00:00.000Z',
    messages: [
      { role: 'system', content: 'СИС' },
      { role: 'user', content: 'прошлый вопрос' },
    ],
  };
}

/** Хранилище-заглушка для сессий: записывает сохранения, позволяет задать содержимое. */
function fakeStore(sessions: Session[] = []): SessionStore & { saved: Session[] } {
  const map = new Map(sessions.map(session => [session.id, session]));
  const saved: Session[] = [];
  return {
    saved,
    list: () => sessions.map(summarize),
    load: id => map.get(id) ?? null,
    save: session => {
      saved.push(session);
      map.set(session.id, session);
    },
    latest: () => sessions[sessions.length - 1] ?? null,
  };
}

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
  stream = true,
  store: SessionStore | null = null,
  session: Session = makeSession(config),
  memory: MemoryKind = 'window',
  keepRecent = 6,
  memorySettings?: MemorySettings,
): { finished: Promise<void>; text: () => string } {
  const input = new PassThrough();
  let buffer = '';
  let next = 0;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      const text = chunk.toString();
      buffer += text;
      // Подаём следующую строку на приглашение «Вы: » и на запрос подтверждения «(да/нет)».
      if ((text.includes('Вы: ') || text.includes('(да/нет)')) && next < lines.length) {
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
    stream,
    memory,
    keepRecent,
    session,
    store,
    input,
    output,
    readline.createInterface,
    memorySettings ?? { enabled: false, profileStore: null, taskStore: null },
  );
  return { finished, text: () => buffer };
}

/** Клиент с подменённым completeWithUsage (используется в не-стрим режиме). */
function clientWith(
  t: TestContext,
  impl: (
    messages: ChatMessage[],
    options: CompleteOptions,
  ) => Promise<CompletionResult> | CompletionResult,
): ChatCompletionClient {
  const client = new ChatCompletionClient(makeConfig());
  t.mock.method(client, 'completeWithUsage', impl);
  return client;
}

/**
 * Клиент с подменённым streamWithUsage: impl(messages, options) даёт полный текст
 * ответа, который отдаётся одной content-дельтой; capture видит опции запроса.
 */
function clientWithStream(
  t: TestContext,
  impl: (messages: ChatMessage[], options: CompleteOptions) => Promise<string> | string,
  capture?: (messages: ChatMessage[], options: CompleteOptions) => void,
): ChatCompletionClient {
  const client = new ChatCompletionClient(makeConfig());
  t.mock.method(
    client,
    'streamWithUsage',
    async (
      messages: ChatMessage[],
      options: CompleteOptions,
      onDelta: (delta: StreamDelta) => void,
    ) => {
      capture?.(messages, options);
      const content = await impl(messages, options);
      onDelta({ content });
      return { content, usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } };
    },
  );
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
  it('передаёт клиенту AbortSignal, ограничения и disableThinking, возвращает ответ+usage', async t => {
    let capturedOptions: CompleteOptions | undefined;
    const client = clientWith(t, async (_messages, options) => {
      capturedOptions = options;
      return { content: 'ответ', usage: undefined };
    });

    const result = await askModel(
      client,
      [{ role: 'user', content: 'x' }],
      5000,
      { maxTokens: 50, stop: ['END'], responseFormat: { type: 'json_object' } },
      true,
      0.3,
    );

    assert.equal(result.content, 'ответ');
    assert.ok(capturedOptions?.signal instanceof AbortSignal);
    assert.equal(capturedOptions?.maxTokens, 50);
    assert.deepEqual(capturedOptions?.stop, ['END']);
    assert.deepEqual(capturedOptions?.responseFormat, { type: 'json_object' });
    assert.equal(capturedOptions?.disableThinking, true);
    assert.equal(capturedOptions?.temperature, 0.3);
  });
});

describe('runOnce', () => {
  it('без стрима пишет ответ модели и шлёт system+user', async t => {
    const calls: unknown[] = [];
    const client = clientWith(t, async messages => {
      calls.push(messages);
      return { content: 'единственный ответ', usage: undefined };
    });
    const output = makeCollector();

    await runOnce(client, makeConfig(), 'привет', {}, false, 0.7, false, output.stream);

    assert.equal(output.text(), 'единственный ответ\n');
    assert.deepEqual(calls[0], [
      { role: 'system', content: 'Ты — ассистент.' },
      { role: 'user', content: 'привет' },
    ]);
  });

  it('со стримом печатает ответ и завершает переводом строки', async t => {
    const client = clientWithStream(t, () => 'потоковый ответ');
    const output = makeCollector();

    await runOnce(client, makeConfig(), 'привет', {}, false, 0.7, true, output.stream);

    assert.equal(output.text(), 'потоковый ответ\n');
  });
});

describe('runInteractive', () => {
  it('ведёт диалог, пропускает пустой ввод и выходит по /quit', async t => {
    const client = clientWithStream(t, () => 'ОТВЕТ');

    const { finished, text } = driveInteractive(client, ['Привет', '', '/quit']);
    await finished;

    assert.match(text(), /Чат с моделью «test-model»/);
    assert.match(text(), /Ассистент: ОТВЕТ/);
    assert.match(text(), /До встречи!/);
  });

  it('печатает ошибку и откатывает ход, затем выходит по /exit', async t => {
    const client = clientWithStream(t, () => {
      throw new Error('сбой API');
    });

    const { finished, text } = driveInteractive(client, ['вопрос', '/exit']);
    await finished;

    assert.match(text(), /\[ошибка\] сбой API/);
    assert.match(text(), /До встречи!/);
  });

  it('без стрима печатает полный ответ ассистента', async t => {
    const client = clientWith(t, async () => ({ content: 'ПОЛНЫЙ ОТВЕТ', usage: undefined }));

    const { finished, text } = driveInteractive(
      client,
      ['Привет', '/exit'],
      0.7,
      makeConfig(),
      false,
    );
    await finished;

    assert.match(text(), /Ассистент: ПОЛНЫЙ ОТВЕТ/);
    assert.match(text(), /До встречи!/);
  });

  it('выходит штатно при Ctrl+C (SIGINT закрывает интерфейс)', async t => {
    const client = clientWithStream(t, () => 'не-важно');
    const input = new PassThrough();
    const output = makeCollector();
    let captured: readline.Interface | undefined;

    const finished = runInteractive(
      client,
      makeConfig(),
      {},
      false,
      0.7,
      true,
      'window',
      6,
      makeSession(),
      null,
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
    const client = clientWithStream(
      t,
      () => 'ОТВЕТ',
      (_messages, options) => {
        capturedTemperature = options.temperature;
      },
    );

    const { finished, text } = driveInteractive(client, ['/temp 0.2', 'привет', '/exit']);
    await finished;

    assert.match(text(), /Температура установлена: 0.2/);
    assert.equal(capturedTemperature, 0.2);
  });

  it('сообщает о некорректной температуре в /temp', async t => {
    const client = clientWithStream(t, () => 'ОТВЕТ');

    const { finished, text } = driveInteractive(client, ['/temp abc', '/exit']);
    await finished;

    assert.match(text(), /Некорректная температура/);
  });

  it('обрезает историю скользящим окном по бюджету токенов', async t => {
    const sentBatches: ChatMessage[][] = [];
    const client = clientWithStream(
      t,
      () => 'короткий ответ',
      messages => {
        sentBatches.push(messages);
      },
    );
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

  it('сохраняет сессию после хода (полный транскрипт), store=null не падает', async t => {
    const client = clientWithStream(t, () => 'ОТВЕТ');
    const store = fakeStore();
    const session = makeSession();

    const { finished } = driveInteractive(
      client,
      ['привет', '/exit'],
      0.7,
      makeConfig(),
      true,
      store,
      session,
    );
    await finished;

    assert.equal(store.saved.length, 1); // сохранили после завершённого обмена
    assert.deepEqual(
      session.messages.map(message => message.role),
      ['system', 'user', 'assistant'],
    ); // полный транскрипт растёт
    assert.equal(session.messages.at(-1)?.content, 'ОТВЕТ');
    assert.notEqual(session.updatedAt, ''); // время обновления проставлено
  });

  it('печатает статистику (вход/выход/история) под ответом', async t => {
    const client = clientWithStream(t, () => 'ОТВЕТ');
    const { finished, text } = driveInteractive(client, ['привет', '/exit']);
    await finished;

    assert.match(text(), /\[вход 1 · выход 2 · история ~\d+/);
  });

  it('при выходе печатает сводку за сессию с суммой токенов', async t => {
    const client = clientWithStream(t, () => 'ОК'); // usage {1,2,3} за каждый ход
    const { finished, text } = driveInteractive(client, ['раз', 'два', '/exit']);
    await finished;

    assert.match(text(), /Итого за сессию: вход 2 · выход 4 · всего 6/);
  });

  it('без запросов сводку за сессию не печатает', async t => {
    const client = clientWithStream(t, () => 'неважно');
    const { finished, text } = driveInteractive(client, ['/exit']);
    await finished;

    assert.doesNotMatch(text(), /Итого за сессию/);
    assert.match(text(), /До встречи!/);
  });

  it('стратегия summary: после N реплик сжатие помечается и идёт в итоги', async t => {
    const client = new ChatCompletionClient(makeConfig());
    t.mock.method(
      client,
      'streamWithUsage',
      async (
        _messages: ChatMessage[],
        _options: CompleteOptions,
        onDelta: (delta: StreamDelta) => void,
      ) => {
        onDelta({ content: 'ОК' });
        return {
          content: 'ОК',
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        };
      },
    );
    t.mock.method(client, 'completeWithUsage', async () => ({
      content: 'резюме',
      usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
    }));
    const config = makeConfig();

    // N=2: после второго хода старые реплики выходят за окно и сворачиваются.
    const { finished, text } = driveInteractive(
      client,
      ['раз', 'два', 'три', '/exit'],
      0.7,
      config,
      true,
      null,
      makeSession(config),
      'summary',
      2,
    );
    await finished;

    assert.match(text(), /\[сжатие · вход 7 · выход 5/); // прогон сжатия помечен
    assert.match(text(), /Итого за сессию:/); // сжатие учтено в итогах
  });

  it('стратегия facts: обновление фактов помечается [факты] и идёт в итоги', async t => {
    const client = new ChatCompletionClient(makeConfig());
    t.mock.method(
      client,
      'streamWithUsage',
      async (
        _messages: ChatMessage[],
        _options: CompleteOptions,
        onDelta: (delta: StreamDelta) => void,
      ) => {
        onDelta({ content: 'ОК' });
        return {
          content: 'ОК',
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        };
      },
    );
    t.mock.method(client, 'completeWithUsage', async () => ({
      content: 'Цель: сайт',
      usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
    }));
    const config = makeConfig();

    const { finished, text } = driveInteractive(
      client,
      ['привет', '/exit'],
      0.7,
      config,
      true,
      null,
      makeSession(config),
      'facts',
      2,
    );
    await finished;

    assert.match(text(), /\[факты · вход 7 · выход 5/); // обновление фактов помечено
    assert.match(text(), /Итого за сессию:/); // вызов учтён в итогах
  });

  it('/help печатает список команд', async t => {
    const client = clientWithStream(t, () => 'X');
    const { finished, text } = driveInteractive(client, ['/help', '/exit']);
    await finished;

    assert.match(text(), /\/branch/);
    assert.match(text(), /\/switch/);
    assert.match(text(), /\/system/);
  });

  it('/reset начинает новую сессию', async t => {
    const client = clientWithStream(t, () => 'X');
    const { finished, text } = driveInteractive(client, ['/reset', '/exit']);
    await finished;

    assert.match(text(), /Начата новая сессия/);
  });

  it('/sessions при --ephemeral сообщает об отключённом хранилище', async t => {
    const client = clientWithStream(t, () => 'X');
    const { finished, text } = driveInteractive(
      client,
      ['/sessions', '/exit'],
      0.7,
      makeConfig(),
      true,
      null,
    );
    await finished;

    assert.match(text(), /отключено/);
  });

  it('/sessions со хранилищем печатает список', async t => {
    const client = clientWithStream(t, () => 'X');
    const { finished, text } = driveInteractive(
      client,
      ['/sessions', '/exit'],
      0.7,
      makeConfig(),
      true,
      fakeStore(),
    );
    await finished;

    assert.match(text(), /Сохранённых веток нет/);
  });

  it('/branch и /switch при --ephemeral сообщают об отключённом хранилище', async t => {
    const client = clientWithStream(t, () => 'X');
    const { finished, text } = driveInteractive(
      client,
      ['/branch alpha', '/switch alpha', '/exit'],
      0.7,
      makeConfig(),
      true,
      null,
    );
    await finished;

    assert.match(text(), /отключено/);
  });

  it('/branch без имени — подсказка', async t => {
    const client = clientWithStream(t, () => 'X');
    const { finished, text } = driveInteractive(
      client,
      ['/branch', '/exit'],
      0.7,
      makeConfig(),
      true,
      fakeStore(),
    );
    await finished;

    assert.match(text(), /Укажите имя ветки/);
  });

  it('/branch с занятым именем — «уже существует»', async t => {
    const client = clientWithStream(t, () => 'X');
    const session = createSession(
      'm',
      [{ role: 'system', content: 'СИС' }],
      undefined,
      'aa',
      'main',
    );
    const { finished, text } = driveInteractive(
      client,
      ['/branch main', '/exit'],
      0.7,
      makeConfig(),
      true,
      fakeStore(),
      session,
    );
    await finished;

    assert.match(text(), /Ветка «main» уже существует/);
  });

  it('/branch создаёт ветку от текущего места и переключается на неё', async t => {
    const client = clientWithStream(t, () => 'X');
    const store = fakeStore();
    const session = createSession(
      'm',
      [{ role: 'system', content: 'СИС' }],
      undefined,
      'aa',
      'main',
    );
    const { finished, text } = driveInteractive(
      client,
      ['/branch feature', '/exit'],
      0.7,
      makeConfig(),
      true,
      store,
      session,
    );
    await finished;

    assert.match(text(), /Создана ветка «feature»/);
    // Сохранены и исходная ветка main, и новая feature.
    assert.ok(store.saved.some(s => s.label === 'main'));
    assert.ok(store.saved.some(s => s.label === 'feature'));
  });

  it('/switch без аргумента — подсказка', async t => {
    const client = clientWithStream(t, () => 'X');
    const { finished, text } = driveInteractive(
      client,
      ['/switch', '/exit'],
      0.7,
      makeConfig(),
      true,
      fakeStore(),
    );
    await finished;

    assert.match(text(), /Укажите имя или id ветки/);
  });

  it('/switch на текущую ветку — «уже в ветке»', async t => {
    const client = clientWithStream(t, () => 'X');
    const session = createSession(
      'm',
      [{ role: 'system', content: 'СИС' }],
      undefined,
      'aa',
      'main',
    );
    const { finished, text } = driveInteractive(
      client,
      ['/switch main', '/exit'],
      0.7,
      makeConfig(),
      true,
      fakeStore(),
      session,
    );
    await finished;

    assert.match(text(), /Уже в ветке «main»/);
  });

  it('/switch несуществующей ветки — «не найдена»', async t => {
    const client = clientWithStream(t, () => 'X');
    const { finished, text } = driveInteractive(
      client,
      ['/switch нет', '/exit'],
      0.7,
      makeConfig(),
      true,
      fakeStore(),
    );
    await finished;

    assert.match(text(), /не найдена: нет/);
  });

  it('/switch по id восстанавливает ветку', async t => {
    const client = clientWithStream(t, () => 'X');
    const { finished, text } = driveInteractive(
      client,
      ['/switch sess-1', '/exit'],
      0.7,
      makeConfig(),
      true,
      fakeStore([storedSession('sess-1')]),
    );
    await finished;

    assert.match(text(), /Переключились на ветку/);
  });

  it('/switch по имени (label) восстанавливает ветку', async t => {
    const client = clientWithStream(t, () => 'X');
    const labelled = { ...storedSession('sess-3'), label: 'alpha' };
    const { finished, text } = driveInteractive(
      client,
      ['/switch alpha', '/exit'],
      0.7,
      makeConfig(),
      true,
      fakeStore([labelled]),
    );
    await finished;

    assert.match(text(), /Переключились на ветку «alpha»/);
  });

  it('/system перезаписывает систему и сохраняет (с хранилищем)', async t => {
    const client = clientWithStream(t, () => 'X');
    const store = fakeStore();
    const session = makeSession();
    const { finished, text } = driveInteractive(
      client,
      ['/system Ты пират', '/exit'],
      0.7,
      makeConfig(),
      true,
      store,
      session,
    );
    await finished;

    assert.match(text(), /Системный промпт обновлён/);
    assert.equal(session.messages[0].content, 'Ты пират');
    assert.ok(store.saved.length >= 1);
  });

  it('/system без хранилища меняет систему, но не сохраняет', async t => {
    const client = clientWithStream(t, () => 'X');
    const session = makeSession();
    const { finished, text } = driveInteractive(
      client,
      ['/system Ты эксперт', '/exit'],
      0.7,
      makeConfig(),
      true,
      null,
      session,
    );
    await finished;

    assert.match(text(), /Системный промпт обновлён/);
    assert.equal(session.messages[0].content, 'Ты эксперт');
  });

  it('/file добавляет содержимое файла в контекст и шлёт его в запросе', async t => {
    const dir = mkdtempSync(join(tmpdir(), 'llm-file-'));
    try {
      const path = join(dir, 'note.txt');
      writeFileSync(path, 'СЕКРЕТНЫЙ ТЕКСТ');
      const sent: ChatMessage[][] = [];
      const client = clientWithStream(
        t,
        () => 'ОК',
        messages => sent.push(messages),
      );

      const { finished, text } = driveInteractive(client, [
        `/file ${path}`,
        'что в файле?',
        '/exit',
      ]);
      await finished;

      assert.match(text(), /добавлен в контекст/);
      const lastSent = sent[sent.length - 1];
      assert.ok(lastSent.some(message => message.content.includes('СЕКРЕТНЫЙ ТЕКСТ')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('/file несуществующего файла — ошибка, диалог продолжается', async t => {
    const client = clientWithStream(t, () => 'ОК');
    const { finished, text } = driveInteractive(client, ['/file /нет/файла.txt', '/exit']);
    await finished;

    assert.match(text(), /Не удалось прочитать файл/);
    assert.match(text(), /До встречи!/);
  });
});

describe('estimateTokens', () => {
  it('оценивает число токенов как ceil(длина / 3)', () => {
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens('абвгде'), 2);
    assert.equal(estimateTokens('абвг'), 2); // ceil(4/3)
  });
});

describe('historyTokens / requestCostUsd / formatUsageStats', () => {
  it('historyTokens суммирует оценку по сообщениям (с накладными)', () => {
    const tokens = historyTokens([
      { role: 'system', content: 'абвгде' }, // ceil(6/3)=2 +4 = 6
      { role: 'user', content: 'абв' }, // ceil(3/3)=1 +4 = 5
    ]);
    assert.equal(tokens, 11);
  });

  it('requestCostUsd считает по тарифам $/1M', () => {
    const cost = requestCostUsd(
      { prompt_tokens: 1_000_000, completion_tokens: 2_000_000, total_tokens: 3_000_000 },
      makeConfig({ priceInputPer1M: 0.5, priceOutputPer1M: 1.5 }),
    );
    assert.equal(cost, 0.5 * 1 + 1.5 * 2); // 3.5
  });

  it('formatUsageStats: «н/д» при отсутствии usage', () => {
    assert.match(formatUsageStats(undefined, 42, makeConfig()), /токены: н\/д · история ~42/);
  });

  it('formatUsageStats: подсказка, когда тарифы не заданы', () => {
    const line = formatUsageStats(
      { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      100,
      makeConfig(),
    );
    assert.match(line, /вход 10 · выход 20 · история ~100/);
    assert.match(line, /задайте LLM_PRICE/);
  });

  it('formatUsageStats: стоимость в $ и ₽ при заданных тарифах', () => {
    const line = formatUsageStats(
      { prompt_tokens: 1_000_000, completion_tokens: 0, total_tokens: 1_000_000 },
      0,
      makeConfig({ priceInputPer1M: 2, priceOutputPer1M: 0, usdToRub: 100 }),
    );
    assert.match(line, /\$2\.000000 \/ 200\.0000 ₽/);
  });

  it('formatUsageStats: с меткой-префиксом (для строки сжатия)', () => {
    const line = formatUsageStats(
      { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
      0,
      makeConfig(),
      'сжатие',
    );
    assert.match(line, /\[сжатие · вход 7 · выход 5/);
  });

  it('formatSessionTotals: суммарные токены без тарифов', () => {
    const line = formatSessionTotals(
      { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      makeConfig(),
    );
    assert.match(line, /Итого за сессию: вход 10 · выход 20 · всего 30/);
  });

  it('formatSessionTotals: со стоимостью при заданных тарифах', () => {
    const line = formatSessionTotals(
      { prompt_tokens: 1_000_000, completion_tokens: 0, total_tokens: 1_000_000 },
      makeConfig({ priceInputPer1M: 2, priceOutputPer1M: 0, usdToRub: 100 }),
    );
    assert.match(line, /\$2\.000000 \/ 200\.0000 ₽/);
  });
});

describe('formatAttachment / attachFiles / combinePrompt', () => {
  it('formatAttachment оформляет содержимое с пометкой и кодоблоком', () => {
    const text = formatAttachment('a.ts', 'код');
    assert.match(text, /Содержимое файла «a\.ts»/);
    assert.match(text, /```\nкод\n```/);
  });

  it('attachFiles читает несколько файлов и склеивает их', () => {
    const dir = mkdtempSync(join(tmpdir(), 'llm-files-'));
    try {
      writeFileSync(join(dir, 'a.txt'), 'AAA');
      writeFileSync(join(dir, 'b.txt'), 'BBB');
      const result = attachFiles([join(dir, 'a.txt'), join(dir, 'b.txt')]);
      assert.match(result, /AAA/);
      assert.match(result, /BBB/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('attachFiles бросает понятную ошибку для отсутствующего файла', () => {
    assert.throws(() => attachFiles(['/нет/такого.txt']), /Не удалось прочитать файл/);
  });

  it('combinePrompt: вложения+промпт, только вложения, только промпт, пусто', () => {
    assert.equal(combinePrompt('Ф', 'П'), 'Ф\n\nП');
    assert.equal(combinePrompt('Ф', ''), 'Ф');
    assert.equal(combinePrompt('', 'П'), 'П');
    assert.equal(combinePrompt('', ''), '');
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

describe('createSpinner', () => {
  /** Поток-приёмник с пометкой TTY. */
  function makeTtyCollector(): { stream: Writable & { isTTY?: boolean }; text: () => string } {
    const collector = makeCollector();
    const stream = collector.stream as Writable & { isTTY?: boolean };
    stream.isTTY = true;
    return { stream, text: collector.text };
  }

  it('на TTY анимируется и очищает строку при остановке (повторный stop — no-op)', t => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const out = makeTtyCollector();

    const spinner = createSpinner(out.stream, 'думает…');
    t.mock.timers.tick(100); // первый кадр
    t.mock.timers.tick(100); // второй кадр
    spinner.stop();
    spinner.stop(); // повторный вызов ничего не делает

    assert.match(out.text(), /думает…/);
    assert.match(out.text(), /\[K/); // строка спиннера очищена
  });

  it('без TTY ничего не пишет', () => {
    const out = makeCollector();

    const spinner = createSpinner(out.stream, 'думает…');
    spinner.stop();

    assert.equal(out.text(), '');
  });
});

describe('streamAnswer', () => {
  /** Клиент, чей streamWithUsage отдаёт заданные дельты и итог. */
  function streamingClient(t: TestContext, deltas: StreamDelta[], content: string) {
    const client = new ChatCompletionClient(makeConfig());
    t.mock.method(
      client,
      'streamWithUsage',
      async (
        _messages: ChatMessage[],
        _options: CompleteOptions,
        onDelta: (delta: StreamDelta) => void,
      ) => {
        for (const delta of deltas) onDelta(delta);
        return { content, usage: undefined };
      },
    );
    return client;
  }

  it('печатает content, зовёт onFirstContent один раз, игнорирует reasoning', async t => {
    const client = streamingClient(
      t,
      [{ reasoning: 'дум' }, { content: 'При' }, { content: 'вет' }],
      'Привет',
    );
    const out = makeCollector();
    let firstContentCalls = 0;

    const result = await streamAnswer(
      client,
      [{ role: 'user', content: 'x' }],
      5000,
      {},
      false,
      0.7,
      out.stream,
      () => {
        firstContentCalls++;
        out.stream.write('PFX:');
      },
    );

    assert.equal(result.content, 'Привет');
    assert.equal(firstContentCalls, 1); // префикс печатается ровно на первом видимом токене
    assert.equal(out.text(), 'PFX:Привет'); // reasoning не печатается
  });

  it('работает без onFirstContent', async t => {
    const client = streamingClient(t, [{ content: 'A' }], 'A');
    const out = makeCollector();

    const result = await streamAnswer(
      client,
      [{ role: 'user', content: 'x' }],
      5000,
      {},
      false,
      0.7,
      out.stream,
    );

    assert.equal(result.content, 'A');
    assert.equal(out.text(), 'A');
  });

  it('передаёт idleTimeoutMs (таймаут по простою), а не total-signal', async t => {
    let captured: CompleteOptions | undefined;
    const client = new ChatCompletionClient(makeConfig());
    t.mock.method(
      client,
      'streamWithUsage',
      async (
        _messages: ChatMessage[],
        options: CompleteOptions,
        onDelta: (delta: StreamDelta) => void,
      ) => {
        captured = options;
        onDelta({ content: 'A' });
        return { content: 'A', usage: undefined };
      },
    );
    const out = makeCollector();

    await streamAnswer(client, [{ role: 'user', content: 'x' }], 12345, {}, false, 0.7, out.stream);

    assert.equal(captured?.idleTimeoutMs, 12345); // таймаут по простою = requestTimeoutMs
    assert.equal(captured?.signal, undefined); // total-таймаут не навешиваем
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

  it('--no-stream выключает потоковый вывод; по умолчанию он включён', () => {
    assert.equal(parseArgs(['--no-stream', 'привет']).stream, false);
    assert.equal(parseArgs(['привет']).stream, true);
  });

  it('--ephemeral булев; по умолчанию выключен, ветка не задана', () => {
    assert.equal(parseArgs(['--ephemeral']).ephemeral, true);
    const none = parseArgs(['привет']);
    assert.equal(none.ephemeral, false);
    assert.equal(none.switchTo, undefined);
    assert.equal(none.branchName, undefined);
  });

  it('--switch без значения = last, с = задаёт имя/id', () => {
    assert.equal(parseArgs(['--switch']).switchTo, 'last');
    assert.equal(parseArgs(['--switch=alpha']).switchTo, 'alpha');
    assert.equal(parseArgs(['--switch=20260610T100000-ab']).switchTo, '20260610T100000-ab');
  });

  it('--branch задаёт имя новой ветки', () => {
    assert.equal(parseArgs(['--branch=alpha']).branchName, 'alpha');
    assert.equal(parseArgs(['--branch', 'beta']).branchName, 'beta');
    assert.equal(parseArgs(['привет']).branchName, undefined);
  });

  it('флаги слоистой памяти: --no-memory, --task, --profile-tokens, --task-tokens', () => {
    const a = parseArgs(['--no-memory']);
    assert.equal(a.noMemory, true);
    assert.equal(parseArgs(['привет']).noMemory, false);

    assert.equal(parseArgs(['--task', 'Сделать сайт']).task, 'Сделать сайт');
    assert.equal(parseArgs(['--task=Бот']).task, 'Бот');
    assert.equal(parseArgs(['привет']).task, undefined);

    assert.equal(parseArgs(['--profile-tokens=300']).profileTokens, 300);
    assert.equal(parseArgs(['--task-tokens=700']).taskTokens, 700);
    assert.equal(parseArgs(['привет']).profileTokens, undefined);
    assert.equal(parseArgs(['привет']).taskTokens, undefined);
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

  it('--file можно указать несколько раз', () => {
    const result = parseArgs(['--file', 'a.txt', '--file=b.txt', 'вопрос']);
    assert.deepEqual(result.files, ['a.txt', 'b.txt']);
    assert.equal(result.prompt, 'вопрос');
  });

  it('--memory принимает window/summary/facts; по умолчанию window', () => {
    assert.equal(parseArgs(['--memory=summary']).memory, 'summary');
    assert.equal(parseArgs(['--memory', 'window']).memory, 'window');
    assert.equal(parseArgs(['--memory=facts']).memory, 'facts');
    assert.equal(parseArgs(['привет']).memory, 'window');
  });

  it('--memory отвергает иные значения', () => {
    assert.throws(() => parseArgs(['--memory=foo']), /window, summary или facts/);
  });

  it('--keep-recent принимает положительное целое; по умолчанию задан', () => {
    assert.equal(parseArgs(['--keep-recent=3']).keepRecent, 3);
    assert.equal(typeof parseArgs(['привет']).keepRecent, 'number');
  });

  it('--keep-recent отвергает невалидное', () => {
    assert.throws(() => parseArgs(['--keep-recent=0']), /положительное целое/);
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

describe('стратегии памяти (createMemoryStrategy)', () => {
  const sys: ChatMessage = { role: 'system', content: 'СИС' };
  const big = (role: ChatMessage['role'], n: number): ChatMessage => ({
    role,
    content: `${role}-${n} ${'x'.repeat(60)}`,
  });

  it('window: passthrough = trimHistoryToBudget', async () => {
    const strategy = createMemoryStrategy(
      'window',
      10_000,
      6,
      new ChatCompletionClient(makeConfig()),
      5000,
    );
    const messages = [sys, big('user', 1), big('assistant', 1)];
    assert.deepEqual(await strategy.prepare(messages), trimHistoryToBudget(messages, 10_000));
    strategy.reset(); // no-op, не падает
  });

  it('summary: реплик не больше N — без сжатия, резюме не добавляется', async t => {
    const client = clientWith(t, async () => ({ content: 'не-нужно', usage: undefined }));
    const strategy = createMemoryStrategy('summary', 1000, 2, client, 5000); // N=2
    const result = await strategy.prepare([sys, big('user', 1), big('assistant', 1)]);

    assert.deepEqual(
      result.map(m => m.role),
      ['system', 'user', 'assistant'],
    );
    assert.ok(!result.some(m => m.content.includes('Краткое содержание')));
  });

  it('summary: только система', async t => {
    const client = clientWith(t, async () => ({ content: 'x', usage: undefined }));
    const strategy = createMemoryStrategy('summary', 1000, 2, client, 5000);
    assert.deepEqual(await strategy.prepare([sys]), [sys]);
  });

  it('summary: сворачивает всё, кроме последних N; второй прогон — с непустым резюме', async t => {
    let folds = 0;
    const client = clientWith(t, async () => {
      folds++;
      return {
        content: 'РЕЗ',
        usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
      };
    });
    const strategy = createMemoryStrategy('summary', 1000, 2, client, 5000); // N=2
    const compressions: (Usage | undefined)[] = [];
    const m1 = [
      sys,
      big('user', 1),
      big('assistant', 1),
      big('user', 2),
      big('assistant', 2),
      big('user', 3),
    ];

    const r1 = await strategy.prepare(m1, u => compressions.push(u));
    assert.equal(r1[0], sys);
    assert.equal(r1[1].role, 'system'); // резюме как system-сообщение
    assert.match(r1[1].content, /Краткое содержание/);
    assert.equal(r1.length, 4); // система + резюме + последние 2 реплики
    assert.ok(r1[2].content.startsWith('assistant-2'));
    assert.ok(r1[3].content.startsWith('user-3')); // дословно — последние 2

    const m2 = [...m1, big('assistant', 3), big('user', 4)];
    const r2 = await strategy.prepare(m2, u => compressions.push(u));
    assert.match(r2[1].content, /Краткое содержание/);
    assert.ok(r2.some(m => m.content.startsWith('user-4')));
    assert.equal(folds, 2); // два прогона сжатия (пустое и непустое резюме)
    assert.equal(compressions.length, 2);
  });

  it('summary: без onCompression тоже сворачивает', async t => {
    const client = clientWith(t, async () => ({ content: 'РЕЗ', usage: undefined }));
    const strategy = createMemoryStrategy('summary', 1000, 1, client, 5000); // N=1
    const messages = [sys, big('user', 1), big('assistant', 1), big('user', 2)];
    const result = await strategy.prepare(messages); // onCompression не передан
    assert.match(result[1].content, /Краткое содержание/);
  });

  it('summary: при сбое сжатия откатывается к окну', async t => {
    const client = clientWith(t, async () => {
      throw new Error('сжатие упало');
    });
    const strategy = createMemoryStrategy('summary', 1000, 1, client, 5000);
    const messages = [sys, big('user', 1), big('assistant', 1), big('user', 2)];
    assert.deepEqual(await strategy.prepare(messages), trimHistoryToBudget(messages, 1000));
  });

  it('summary: reset() очищает резюме', async t => {
    const client = clientWith(t, async () => ({ content: 'РЕЗ', usage: undefined }));
    const strategy = createMemoryStrategy('summary', 1000, 1, client, 5000);
    const messages = [sys, big('user', 1), big('assistant', 1), big('user', 2)];
    await strategy.prepare(messages); // создаём резюме
    strategy.reset();
    const after = await strategy.prepare([sys, big('user', 1)]); // ≤ N → без резюме
    assert.ok(!after.some(m => m.content.includes('Краткое содержание')));
  });

  it('facts: добавляет блок фактов и держит последние N дословно', async t => {
    let updates = 0;
    const client = clientWith(t, async () => {
      updates++;
      return {
        content: 'Цель: сайт',
        usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
      };
    });
    const strategy = createMemoryStrategy('facts', 1000, 2, client, 5000); // N=2
    const updateUsage: (Usage | undefined)[] = [];
    const messages = [
      sys,
      big('user', 1),
      big('assistant', 1),
      big('user', 2),
      big('assistant', 2),
      big('user', 3),
    ];

    const result = await strategy.prepare(messages, u => updateUsage.push(u));
    assert.equal(result[0], sys);
    assert.equal(result[1].role, 'system'); // блок фактов как system-сообщение
    assert.match(result[1].content, /Известные факты/);
    assert.match(result[1].content, /Цель: сайт/);
    assert.equal(result.length, 4); // система + факты + последние 2 реплики
    assert.ok(result[2].content.startsWith('assistant-2'));
    assert.ok(result[3].content.startsWith('user-3'));
    assert.equal(updates, 1);
    assert.equal(updateUsage.length, 1);
  });

  it('facts: на втором ходу учитывает только новые реплики', async t => {
    const seen: string[] = [];
    const client = clientWith(t, async messages => {
      seen.push(messages[0].content);
      return { content: 'Цель: сайт', usage: undefined };
    });
    const strategy = createMemoryStrategy('facts', 1000, 2, client, 5000);
    const m1 = [sys, big('user', 1)];
    await strategy.prepare(m1);
    const m2 = [...m1, big('assistant', 1), big('user', 2)];
    await strategy.prepare(m2);
    // Второй промпт обновления содержит только новое (ответ 1 + вопрос 2), не вопрос 1.
    assert.ok(seen[1].includes('assistant-1'));
    assert.ok(seen[1].includes('user-2'));
    assert.ok(!seen[1].includes('user-1 '));
  });

  it('facts: при сбое обновления оставляет прежние факты', async t => {
    let calls = 0;
    const client = clientWith(t, async () => {
      calls++;
      if (calls === 2) throw new Error('обновление упало');
      return { content: 'Цель: сайт', usage: undefined };
    });
    const strategy = createMemoryStrategy('facts', 1000, 1, client, 5000);
    await strategy.prepare([sys, big('user', 1)]); // факты созданы
    const after = await strategy.prepare([
      sys,
      big('user', 1),
      big('assistant', 1),
      big('user', 2),
    ]);
    // Несмотря на сбой второго обновления, прежний блок фактов сохранён.
    assert.match(after[1].content, /Цель: сайт/);
  });

  it('facts: только система — без вызова модели и без блока фактов', async t => {
    const client = clientWith(t, async () => ({ content: 'x', usage: undefined }));
    const strategy = createMemoryStrategy('facts', 1000, 2, client, 5000);
    const result = await strategy.prepare([sys]);
    assert.deepEqual(result, [sys]);
  });

  it('facts: подстраховка окном, если факты + N не влезают в бюджет', async t => {
    const client = clientWith(t, async () => ({ content: 'x'.repeat(900), usage: undefined }));
    const strategy = createMemoryStrategy('facts', 100, 5, client, 5000); // крошечный бюджет
    const messages = [sys, big('user', 1), big('assistant', 1), big('user', 2)];
    const result = await strategy.prepare(messages);
    // Блок фактов сам по себе больше бюджета → окно оставляет системные сообщения
    // и лишь самую свежую реплику (старые user-1/assistant-1 обрезаются).
    assert.deepEqual(
      result.map(m => m.role),
      ['system', 'system', 'user'],
    );
    assert.match(result[1].content, /Известные факты/);
    assert.ok(result[2].content.startsWith('user-2'));
  });

  it('facts: reset() очищает блок фактов', async t => {
    const client = clientWith(t, async () => ({ content: 'Цель: сайт', usage: undefined }));
    const strategy = createMemoryStrategy('facts', 1000, 1, client, 5000);
    await strategy.prepare([sys, big('user', 1)]); // создаём факты
    strategy.reset();
    // clientWith вернёт те же факты, но проверяем, что factedThrough сброшен:
    const after = await strategy.prepare([sys]); // нет реплик → без вызова, без блока
    assert.deepEqual(after, [sys]);
  });
});

describe('интерактив: команды слоистой памяти', () => {
  const layered: MemorySettings = { enabled: true, profileStore: null, taskStore: null };

  it('/task задаёт и показывает текущую задачу', async t => {
    const client = clientWithStream(t, () => 'X');
    const { finished, text } = driveInteractive(
      client,
      ['/task Сделать лендинг', '/task', '/exit'],
      0.7,
      makeConfig(),
      true,
      null,
      makeSession(),
      'window',
      6,
      layered,
    );
    await finished;
    assert.match(text(), /Задача установлена: Сделать лендинг/);
    assert.match(text(), /Текущая задача: Сделать лендинг/);
  });

  it('/tasks, /task switch и /task done', async t => {
    const client = clientWithStream(t, () => 'X');
    const { finished, text } = driveInteractive(
      client,
      [
        '/task Первая',
        '/task Вторая',
        '/tasks',
        '/task switch Первая',
        '/task done',
        '/task done',
        '/exit',
      ],
      0.7,
      makeConfig(),
      true,
      null,
      makeSession(),
      'window',
      6,
      layered,
    );
    await finished;
    assert.match(text(), /Задачи:/);
    assert.match(text(), /Переключились на задачу «Первая»/);
    assert.match(text(), /Задача «Первая» закрыта/);
    assert.match(text(), /Активной задачи нет/); // второй /task done
  });

  it('/task switch несуществующей — «не найдена»', async t => {
    const client = clientWithStream(t, () => 'X');
    const { finished, text } = driveInteractive(
      client,
      ['/task switch нет', '/exit'],
      0.7,
      makeConfig(),
      true,
      null,
      makeSession(),
      'window',
      6,
      layered,
    );
    await finished;
    assert.match(text(), /Задача не найдена: нет/);
  });

  it('/task delete удаляет задачу и снимает её с сессии', async t => {
    const client = clientWithStream(t, () => 'X');
    const session = makeSession();
    const { finished, text } = driveInteractive(
      client,
      ['/task Черновик', '/task delete Черновик', '/task delete нет', '/task', '/exit'],
      0.7,
      makeConfig(),
      true,
      fakeStore(),
      session,
      'window',
      6,
      layered,
    );
    await finished;
    assert.match(text(), /Задача «Черновик» удалена/);
    assert.match(text(), /Задача не найдена: нет/);
    assert.match(text(), /Активной задачи нет/); // удалили активную — отвязалась
    assert.equal(session.taskId, undefined);
  });

  it('/profile и /forget на пустом профиле', async t => {
    const client = clientWithStream(t, () => 'X');
    const { finished, text } = driveInteractive(
      client,
      ['/profile', '/forget 1', '/forget abc', '/exit'],
      0.7,
      makeConfig(),
      true,
      null,
      makeSession(),
      'window',
      6,
      layered,
    );
    await finished;
    assert.match(text(), /Профиль пуст/);
    assert.match(text(), /Нет такого пункта профиля/);
  });

  it('команды памяти при --no-memory сообщают, что она выключена', async t => {
    const client = clientWithStream(t, () => 'X');
    const { finished, text } = driveInteractive(
      client,
      [
        '/task X',
        '/tasks',
        '/profile',
        '/forget 1',
        '/task done',
        '/task switch Y',
        '/task delete Z',
        '/task',
        '/exit',
      ],
      0.7,
      makeConfig(),
      true,
      null,
      makeSession(),
      'window',
      6,
      { enabled: false, profileStore: null, taskStore: null },
    );
    await finished;
    assert.match(text(), /Слоистая память выключена/);
  });

  it('стартовая задача (initialTaskTitle) и сохранение задач в хранилище', async t => {
    const client = clientWithStream(t, () => 'X');
    const taskMap = new Map<string, Task>();
    const taskStore: TaskStore = {
      list: () => [...taskMap.values()].map(summarizeTask),
      load: id => taskMap.get(id) ?? null,
      save: task => {
        taskMap.set(task.id, task);
      },
      delete: id => {
        taskMap.delete(id);
      },
    };
    const sessionStore = fakeStore();
    const session = makeSession();
    const { finished, text } = driveInteractive(
      client,
      ['/task Вторая', '/task switch Старт', '/task done', '/exit'],
      0.7,
      makeConfig(),
      true,
      sessionStore,
      session,
      'window',
      6,
      { enabled: true, profileStore: null, taskStore, initialTaskTitle: 'Старт' },
    );
    await finished;
    assert.match(text(), /Задача установлена: Вторая/);
    assert.match(text(), /Переключились на задачу «Старт»/);
    assert.match(text(), /Задача «Старт» закрыта/);
    assert.equal(session.taskId, undefined); // после done задача отвязана
    assert.ok(sessionStore.saved.length >= 1); // сессия сохранялась при сменах задачи
  });

  it('обмен: извлечение памяти помечается [память], профиль консолидируется [профиль]', async t => {
    const client = new ChatCompletionClient(makeConfig());
    t.mock.method(
      client,
      'streamWithUsage',
      async (
        _messages: ChatMessage[],
        _options: CompleteOptions,
        onDelta: (delta: StreamDelta) => void,
      ) => {
        onDelta({ content: 'OK' });
        return {
          content: 'OK',
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        };
      },
    );
    t.mock.method(client, 'completeWithUsage', async (messages: ChatMessage[]) => {
      const content = messages[0].content;
      if (content.includes('JSON')) {
        return {
          content: '{"task":["цель: сайт"],"user":["кратко"]}',
          usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
        };
      }
      return {
        content: '- кратко\n- TypeScript',
        usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
      };
    });
    const { finished, text } = driveInteractive(
      client,
      ['Сделай сайт', '/forget 1', '/exit'],
      0.7,
      makeConfig(),
      true,
      null,
      makeSession(),
      'window',
      6,
      layered,
    );
    await finished;
    assert.match(text(), /\[память\] профиль ← «кратко»/); // явно: что и куда записано
    assert.match(text(), /\[память · вход 7 · выход 5/); // строка стоимости извлечения
    assert.match(text(), /Забыто: кратко/); // /forget удалил извлечённое предпочтение
    assert.match(text(), /\[профиль\] консолидировано/); // явная пометка консолидации
    assert.match(text(), /\[профиль · вход 4 · выход 3/); // строка стоимости консолидации
    assert.match(text(), /Итого за сессию:/);
  });

  it('обмен с активной задачей: лог показывает запись в задачу', async t => {
    const client = new ChatCompletionClient(makeConfig());
    t.mock.method(
      client,
      'streamWithUsage',
      async (
        _messages: ChatMessage[],
        _options: CompleteOptions,
        onDelta: (delta: StreamDelta) => void,
      ) => {
        onDelta({ content: 'OK' });
        return {
          content: 'OK',
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        };
      },
    );
    t.mock.method(client, 'completeWithUsage', async (messages: ChatMessage[]) =>
      messages[0].content.includes('JSON')
        ? { content: '{"task":["цель A","цель B"],"user":[]}', usage: undefined }
        : { content: '', usage: undefined },
    );
    const { finished, text } = driveInteractive(
      client,
      ['/task Сайт', 'добавь две цели', '/exit'],
      0.7,
      makeConfig(),
      true,
      null,
      makeSession(),
      'window',
      6,
      layered,
    );
    await finished;
    assert.match(text(), /\[память\] задача «Сайт» ← 2 факт\(ов\)/);
  });

  /** Клиент авто-определения: извлечение предлагает новую задачу «Сбор ТЗ». */
  function autoTaskClient(t: TestContext): ChatCompletionClient {
    const client = new ChatCompletionClient(makeConfig());
    t.mock.method(
      client,
      'streamWithUsage',
      async (
        _messages: ChatMessage[],
        _options: CompleteOptions,
        onDelta: (delta: StreamDelta) => void,
      ) => {
        onDelta({ content: 'OK' });
        return {
          content: 'OK',
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        };
      },
    );
    t.mock.method(client, 'completeWithUsage', async (messages: ChatMessage[]) =>
      messages[0].content.includes('JSON')
        ? {
            content: '{"task":[],"user":[],"isNewTask":true,"proposedTitle":"Сбор ТЗ"}',
            usage: undefined,
          }
        : { content: '- ничего', usage: undefined },
    );
    return client;
  }

  it('авто-задача: предложение и подтверждение «да» устанавливает задачу', async t => {
    const { finished, text } = driveInteractive(
      autoTaskClient(t),
      ['Собери ТЗ на приложение', 'да', '/task', '/exit'],
      0.7,
      makeConfig(),
      true,
      fakeStore(), // со хранилищем: подтверждённая задача сохраняется в сессию
      makeSession(),
      'window',
      6,
      layered,
    );
    await finished;
    assert.match(text(), /Сделать задачей сессии «Сбор ТЗ»\?/);
    assert.match(text(), /Задача установлена: Сбор ТЗ/);
    assert.match(text(), /Текущая задача: Сбор ТЗ/);
  });

  it('авто-задача: отказ «нет» не ставит задачу', async t => {
    const { finished, text } = driveInteractive(
      autoTaskClient(t),
      ['Собери ТЗ', 'нет', '/task', '/exit'],
      0.7,
      makeConfig(),
      true,
      null,
      makeSession(),
      'window',
      6,
      layered,
    );
    await finished;
    assert.match(text(), /Хорошо, без задачи/);
    assert.match(text(), /Активной задачи нет/);
  });

  it('авто-задача: неявный ответ (не да/нет) — задача не ставится, отвечаем на вопрос', async t => {
    const { finished, text } = driveInteractive(
      autoTaskClient(t),
      ['Собери ТЗ', 'не знаю пока', '/task', '/exit'],
      0.7,
      makeConfig(),
      true,
      null,
      makeSession(),
      'window',
      6,
      layered,
    );
    await finished;
    assert.match(text(), /Сделать задачей сессии «Сбор ТЗ»\?/); // спросили до ответа
    assert.match(text(), /Активной задачи нет/); // неявный ответ — задача не установлена
  });

  it('авто-задача: прерывание ввода на подтверждении завершает чат', async t => {
    const client = autoTaskClient(t);
    const input = new PassThrough();
    let buffer = '';
    let asked = false;
    const output = new Writable({
      write(chunk, _encoding, callback) {
        const text = chunk.toString();
        buffer += text;
        if (text.includes('Вы: ') && !asked) {
          asked = true;
          setImmediate(() => input.write('Собери ТЗ\n'));
        } else if (text.includes('(да/нет)')) {
          setImmediate(() => input.end()); // EOF на подтверждении → штатный выход
        }
        callback();
      },
    });
    await runInteractive(
      client,
      makeConfig(),
      {},
      false,
      0.7,
      true,
      'window',
      6,
      makeSession(),
      null,
      input,
      output,
      readline.createInterface,
      layered,
    );
    assert.match(buffer, /Сделать задачей сессии «Сбор ТЗ»\?/);
    assert.match(buffer, /До встречи!/);
  });
});

describe('layerBudgets', () => {
  it('доли от контекста с потолками; остаток — короткой памяти', () => {
    const b = layerBudgets(7168, 8192);
    assert.equal(b.profile, 256); // 8192/32
    assert.equal(b.task, 512); // 8192/16
    assert.equal(b.short, 7168 - 256 - 512);
  });

  it('применяет потолки на большом контексте', () => {
    const b = layerBudgets(130048, 131072);
    assert.equal(b.profile, 1536); // потолок
    assert.equal(b.task, 3072); // потолок
  });

  it('переопределения важнее эвристики', () => {
    const b = layerBudgets(7168, 8192, 100, 200);
    assert.equal(b.profile, 100);
    assert.equal(b.task, 200);
  });

  it('ужимает слои, если они > половины бюджета истории', () => {
    const b = layerBudgets(1024, 8192, 600, 600); // 1200 > 512
    assert.ok(b.profile + b.task <= 512);
    assert.ok(b.short >= 512);
  });
});

describe('format helpers (задачи и профиль)', () => {
  it('formatTaskList: пусто и со статусами', () => {
    assert.match(formatTaskList([]), /Задач пока нет/);
    const summaries: TaskSummary[] = [
      { id: 'a', title: 'Сайт', status: 'active', createdAt: 't', updatedAt: 't', detailCount: 3 },
      { id: 'b', title: 'Бот', status: 'done', createdAt: 't', updatedAt: 't', detailCount: 0 },
    ];
    const text = formatTaskList(summaries);
    assert.match(text, /• Сайт {2}\(a\) {2}фактов: 3/);
    assert.match(text, /✓ Бот {2}\(b\)/);
  });

  it('formatCurrentTask: нет задачи, с деталями и без', () => {
    assert.match(formatCurrentTask(null), /Активной задачи нет/);
    const task = createTask('Сайт', ['цель: лендинг']);
    assert.match(formatCurrentTask(task), /Текущая задача: Сайт/);
    assert.match(formatCurrentTask(task), /- цель: лендинг/);
    assert.match(formatCurrentTask(createTask('Пусто')), /без деталей/);
  });

  it('formatProfile: пусто и нумерованно', () => {
    assert.match(formatProfile([]), /Профиль пуст/);
    assert.match(formatProfile(['любит кратко', 'TypeScript']), /1\. любит кратко/);
    assert.match(formatProfile(['любит кратко', 'TypeScript']), /2\. TypeScript/);
  });
});

describe('MemoryManager', () => {
  const sys: ChatMessage = { role: 'system', content: 'СИС' };
  const budgets = { profile: 256, task: 512, short: 1000 };

  function makeManager(
    t: TestContext,
    extractImpl: () => Promise<CompletionResult> | CompletionResult,
    over: Partial<{
      enabled: boolean;
      profileStore: ConstructorParameters<typeof MemoryManager>[0]['profileStore'];
      taskStore: TaskStore | null;
    }> = {},
  ): MemoryManager {
    const client = clientWith(t, async () => extractImpl());
    const strategy = createMemoryStrategy('window', budgets.short, 6, client, 5000);
    return new MemoryManager({
      enabled: over.enabled ?? true,
      strategy,
      budgets,
      client,
      requestTimeoutMs: 5000,
      profile: emptyProfile(),
      profileStore: over.profileStore ?? null,
      taskStore: over.taskStore ?? null,
    });
  }

  it('prepare: подмешивает директиву, профиль и задачу; применяет извлечение', async t => {
    const mgr = makeManager(t, () => ({
      content: '{"task":["цель: сайт"],"user":["краткие ответы"]}',
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }));
    mgr.setTask('Сайт');
    const usages: (Usage | undefined)[] = [];
    const result = await mgr.prepare(
      [sys, { role: 'user', content: 'Привет' }],
      () => {},
      u => usages.push(u),
    );

    assert.match(result[0].content, /СИС/);
    assert.match(result[0].content, /задач/i); // директива персонализации
    assert.ok(result.some(m => m.content.includes('Профиль пользователя')));
    assert.ok(result.some(m => m.content.includes('краткие ответы')));
    assert.ok(result.some(m => m.content.includes('Текущая задача: Сайт')));
    assert.ok(result.some(m => m.content.includes('цель: сайт')));
    assert.equal(usages.length, 1);
    assert.deepEqual(mgr.profileEntries(), ['краткие ответы']);
    assert.deepEqual(mgr.currentTask()?.details, ['цель: сайт']);
  });

  it('prepare: выключенный менеджер — passthrough без блоков и без вызова', async t => {
    const mgr = makeManager(
      t,
      () => {
        throw new Error('не должно вызываться');
      },
      { enabled: false },
    );
    const result = await mgr.prepare([sys, { role: 'user', content: 'привет' }]);
    assert.ok(!result.some(m => m.content.includes('Профиль пользователя')));
    assert.ok(!result[0].content.includes('задач'));
  });

  it('prepare: задача без деталей показывается как «без деталей»', async t => {
    const mgr = makeManager(t, () => ({ content: '{"task":[],"user":[]}', usage: undefined }));
    mgr.setTask('Пустая');
    const result = await mgr.prepare([sys, { role: 'user', content: 'привет' }]);
    assert.ok(result.some(m => m.content.includes('(пока без деталей)')));
  });

  it('prepare: невалидный JSON извлечения — мягко, без изменений', async t => {
    const mgr = makeManager(t, () => ({ content: 'не json', usage: undefined }));
    mgr.setTask('Сайт');
    await mgr.prepare([sys, { role: 'user', content: 'привет' }]);
    assert.deepEqual(mgr.currentTask()?.details, []);
    assert.deepEqual(mgr.profileEntries(), []);
  });

  it('prepare: сбой вызова извлечения — мягко, повторим позже', async t => {
    const mgr = makeManager(t, () => {
      throw new Error('сеть упала');
    });
    mgr.setTask('Сайт');
    const result = await mgr.prepare([sys, { role: 'user', content: 'привет' }]);
    assert.deepEqual(mgr.currentTask()?.details, []); // ничего не сломалось
    assert.ok(result.some(m => m.content.includes('Текущая задача: Сайт')));
  });

  it('prepare: профиль обрезается по бюджету', async t => {
    const mgr = makeManager(t, () => ({ content: '{"task":[],"user":[]}', usage: undefined }));
    // Заполним профиль вручную через извлечение крупной строки.
    const long = 'x'.repeat(2000);
    const mgr2 = makeManager(t, () => ({
      content: `{"task":[],"user":["${long}"]}`,
      usage: undefined,
    }));
    await mgr2.prepare([sys, { role: 'user', content: 'привет' }]);
    const result = await mgr2.prepare([sys, { role: 'user', content: 'ещё' }]);
    const block = result.find(m => m.content.includes('Профиль пользователя'));
    assert.ok(block && block.content.includes('…')); // урезано
    void mgr;
  });

  it('consolidate: переписывает профиль из строкового списка', async t => {
    const mgr = makeManager(t, () => ({
      content: '- любит TypeScript\n- предпочитает краткость\n',
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
    const usages: (Usage | undefined)[] = [];
    await mgr.consolidate([sys, { role: 'user', content: 'я на TS' }], u => usages.push(u));
    assert.deepEqual(mgr.profileEntries(), ['любит TypeScript', 'предпочитает краткость']);
    assert.equal(usages.length, 1);
  });

  it('consolidate: выключен или пустой диалог — ничего не делает', async t => {
    const mgr = makeManager(
      t,
      () => {
        throw new Error('не должно вызываться');
      },
      { enabled: false },
    );
    await mgr.consolidate([sys, { role: 'user', content: 'x' }]);
    assert.deepEqual(mgr.profileEntries(), []);

    const mgr2 = makeManager(t, () => {
      throw new Error('не должно вызываться');
    });
    await mgr2.consolidate([sys]); // пустой диалог
    assert.deepEqual(mgr2.profileEntries(), []);
  });

  it('consolidate: сбой вызова — профиль не меняется', async t => {
    const mgr = makeManager(t, () => {
      throw new Error('упало');
    });
    await mgr.consolidate([sys, { role: 'user', content: 'x' }]);
    assert.deepEqual(mgr.profileEntries(), []);
  });

  it('consolidate: профиль строится только из реплик пользователя', async t => {
    let seen = '';
    const client = clientWith(t, async (messages: ChatMessage[]) => {
      seen = messages[0].content;
      return { content: '- любит краткость', usage: undefined };
    });
    const strategy = createMemoryStrategy('window', budgets.short, 6, client, 5000);
    const mgr = new MemoryManager({
      enabled: true,
      strategy,
      budgets,
      client,
      requestTimeoutMs: 5000,
      profile: emptyProfile(),
      profileStore: null,
      taskStore: null,
    });
    await mgr.consolidate([
      sys,
      { role: 'user', content: 'я предпочитаю краткость' },
      { role: 'assistant', content: 'рекомендую NestJS и Prisma' },
    ]);
    assert.match(seen, /краткость/);
    assert.doesNotMatch(seen, /NestJS/); // предложения ассистента в профиль не идут
    assert.deepEqual(mgr.profileEntries(), ['любит краткость']);
  });

  it('consolidate: без реплик пользователя ничего не делает', async t => {
    const mgr = makeManager(t, () => {
      throw new Error('не должно вызываться');
    });
    await mgr.consolidate([sys, { role: 'assistant', content: 'use NestJS' }]);
    assert.deepEqual(mgr.profileEntries(), []);
  });

  it('задачи в памяти: setTask, listTasks, switchTask, closeTask', async t => {
    const mgr = makeManager(t, () => ({ content: '{}', usage: undefined }));
    const t1 = mgr.setTask('Первая');
    const t2 = mgr.setTask('Вторая');
    assert.equal(mgr.currentTask()?.id, t2.id);
    assert.equal(mgr.listTasks().length, 2);

    assert.equal(mgr.switchTask(t1.id)?.id, t1.id); // по id
    assert.equal(mgr.switchTask('Вторая')?.id, t2.id); // по имени
    assert.equal(mgr.switchTask('нет'), null);

    const closed = mgr.closeTask();
    assert.equal(closed, 'Вторая');
    assert.equal(mgr.currentTask(), null);
    assert.equal(mgr.closeTask(), null); // нет активной

    // Реактивация завершённой задачи.
    assert.equal(mgr.switchTask(t2.id)?.status, 'active');
  });

  it('deleteTask: удаляет по имени/id, снимает активную, null если не найдена', async t => {
    const mgr = makeManager(t, () => ({ content: '{}', usage: undefined }));
    const first = mgr.setTask('Первая');
    const second = mgr.setTask('Вторая'); // активная

    assert.equal(mgr.deleteTask('нет'), null);
    assert.equal(mgr.deleteTask('Первая')?.id, first.id); // по имени
    assert.equal(mgr.listTasks().length, 1);
    assert.equal(mgr.currentTask()?.id, second.id); // активная не тронута

    assert.equal(mgr.deleteTask(second.id)?.id, second.id); // удаляем активную по id
    assert.equal(mgr.currentTask(), null); // активная снята
    assert.equal(mgr.listTasks().length, 0);
  });

  it('задачи с хранилищем: list/load идут через store; adopt по id', async t => {
    const stored = createTask('Сохранённая', ['деталь'], new Date(), 'aaa111');
    const taskStore: TaskStore & { saved: Task[] } = (() => {
      const map = new Map<string, Task>([[stored.id, stored]]);
      const saved: Task[] = [];
      return {
        saved,
        list: () => [...map.values()].map(summarizeTask),
        load: id => map.get(id) ?? null,
        save: task => {
          saved.push(task);
          map.set(task.id, task);
        },
        delete: id => {
          map.delete(id);
        },
      };
    })();
    const mgr = makeManager(t, () => ({ content: '{}', usage: undefined }), { taskStore });

    assert.equal(mgr.listTasks().length, 1);
    mgr.adopt(stored.id);
    assert.equal(mgr.currentTask()?.title, 'Сохранённая');
    mgr.adopt(undefined); // сбрасывает активную
    assert.equal(mgr.currentTask(), null);

    const created = mgr.setTask('Новая');
    assert.ok(taskStore.saved.some(task => task.id === created.id)); // сохранена в store
  });

  it('forgetProfile: удаляет пункт по номеру, выход за границы — null', async t => {
    const mgr = makeManager(t, () => ({
      content: '{"task":[],"user":["a","b"]}',
      usage: undefined,
    }));
    await mgr.prepare([sys, { role: 'user', content: 'привет' }]);
    assert.deepEqual(mgr.profileEntries(), ['a', 'b']);
    assert.equal(mgr.forgetProfile(1), 'a');
    assert.deepEqual(mgr.profileEntries(), ['b']);
    assert.equal(mgr.forgetProfile(5), null);
  });

  it('reset: позволяет извлечь заново после смены ветки', async t => {
    let calls = 0;
    const mgr = makeManager(t, () => {
      calls++;
      return { content: '{"task":[],"user":[]}', usage: undefined };
    });
    await mgr.prepare([sys, { role: 'user', content: 'один' }]);
    mgr.reset();
    await mgr.prepare([sys, { role: 'user', content: 'один' }]); // тот же транскрипт
    assert.equal(calls, 2); // после reset извлечение повторилось
  });

  it('с хранилищами и непустым профилем: сохранение, ассистентские реплики, switch по имени', async t => {
    const client = clientWith(t, async (messages: ChatMessage[]) =>
      messages[0].content.includes('JSON')
        ? { content: '{"task":["цель"],"user":["новое"]}', usage: undefined }
        : { content: '- итог', usage: undefined },
    );
    const strategy = createMemoryStrategy('window', budgets.short, 6, client, 5000);
    const taskMap = new Map<string, Task>();
    const taskSaved: Task[] = [];
    const taskStore: TaskStore = {
      list: () => [...taskMap.values()].map(summarizeTask),
      load: id => taskMap.get(id) ?? null,
      save: task => {
        taskSaved.push(task);
        taskMap.set(task.id, task);
      },
      delete: id => {
        taskMap.delete(id);
      },
    };
    const profileSaved: Profile[] = [];
    const startProfile = {
      version: 1,
      entries: [{ text: 'старое', updatedAt: 't' }],
      updatedAt: 't',
    };
    const mgr = new MemoryManager({
      enabled: true,
      strategy,
      budgets,
      client,
      requestTimeoutMs: 5000,
      profile: startProfile,
      profileStore: { load: () => startProfile, save: p => profileSaved.push(p) },
      taskStore,
    });

    const created = mgr.setTask('Сайт'); // сохранится в taskStore
    assert.ok(taskSaved.some(task => task.id === created.id));
    // newMessages с ответом ассистента + непустой профиль → ветки роли и profileContext.
    await mgr.prepare([
      sys,
      { role: 'user', content: 'привет' },
      { role: 'assistant', content: 'ответ' },
      { role: 'user', content: 'ещё' },
    ]);
    assert.ok(profileSaved.length >= 1); // явное предпочтение «новое» сохранено
    assert.equal(mgr.switchTask('Сайт')?.id, created.id); // поиск по имени через store

    await mgr.consolidate([sys, { role: 'user', content: 'я на TS' }]); // store + непустой профиль
    assert.ok(profileSaved.some(p => p.entries.some(e => e.text === 'итог')));
    assert.equal(mgr.forgetProfile(1), 'итог'); // забывание сохраняется в store

    assert.equal(mgr.deleteTask(created.id)?.id, created.id); // удаление идёт в store
    assert.equal(taskStore.load(created.id), null);
  });

  it('авто-определение задачи: предложение, очистка, пустое имя, текущая, отказ', async t => {
    const propose = (title: string) => () => ({
      content: `{"task":[],"user":[],"isNewTask":true,"proposedTitle":"${title}"}`,
      usage: undefined as Usage | undefined,
    });

    const mgr = makeManager(t, propose('Сбор ТЗ'));
    await mgr.prepare([sys, { role: 'user', content: 'давай ТЗ' }]);
    assert.equal(mgr.takeProposal(), 'Сбор ТЗ');
    assert.equal(mgr.takeProposal(), null); // очищено после взятия

    const empty = makeManager(t, () => ({
      content: '{"isNewTask":true,"proposedTitle":""}',
      usage: undefined,
    }));
    await empty.prepare([sys, { role: 'user', content: 'x' }]);
    assert.equal(empty.takeProposal(), null); // пустое имя — не предлагаем

    const same = makeManager(t, propose('Сайт'));
    same.setTask('Сайт');
    await same.prepare([sys, { role: 'user', content: 'x' }]);
    assert.equal(same.takeProposal(), null); // совпадает с текущей задачей

    const refused = makeManager(t, propose('Бот'));
    refused.declineProposal('Бот');
    await refused.prepare([sys, { role: 'user', content: 'x' }]);
    assert.equal(refused.takeProposal(), null); // отклонённое имя не предлагаем
  });

  it('setTask и reset снимают висящее предложение', async t => {
    const propose = () => ({
      content: '{"isNewTask":true,"proposedTitle":"A"}',
      usage: undefined as Usage | undefined,
    });
    const m1 = makeManager(t, propose);
    await m1.prepare([sys, { role: 'user', content: 'x' }]);
    m1.setTask('B');
    assert.equal(m1.takeProposal(), null);

    const m2 = makeManager(t, propose);
    await m2.prepare([sys, { role: 'user', content: 'x' }]);
    m2.reset();
    assert.equal(m2.takeProposal(), null);
  });
});

describe('sessionDirectory', () => {
  it('берёт каталог из LLM_SESSION_DIR, иначе ~/.llm-cli/sessions', () => {
    const saved = process.env.LLM_SESSION_DIR;
    try {
      process.env.LLM_SESSION_DIR = '/tmp/custom-sessions';
      assert.equal(sessionDirectory(), '/tmp/custom-sessions');
      delete process.env.LLM_SESSION_DIR;
      assert.match(sessionDirectory(), /[/\\]\.llm-cli[/\\]sessions$/);
    } finally {
      if (saved === undefined) delete process.env.LLM_SESSION_DIR;
      else process.env.LLM_SESSION_DIR = saved;
    }
  });

  it('profilePath и tasksDirectory лежат рядом с каталогом сессий', () => {
    const saved = process.env.LLM_SESSION_DIR;
    try {
      process.env.LLM_SESSION_DIR = '/tmp/base/sessions';
      assert.equal(profilePath(), '/tmp/base/profile.json');
      assert.equal(tasksDirectory(), '/tmp/base/tasks');
    } finally {
      if (saved === undefined) delete process.env.LLM_SESSION_DIR;
      else process.env.LLM_SESSION_DIR = saved;
    }
  });
});

describe('resolveSession', () => {
  const config = makeConfig({ model: 'glm', systemPrompt: 'СИС' });

  /** Существующая сессия (ветка) для подмены в хранилище. */
  function existing(id: string, label?: string): Session {
    return {
      version: 1,
      id,
      model: 'other',
      ...(label === undefined ? {} : { label }),
      createdAt: '2026-06-10T10:00:00.000Z',
      updatedAt: '2026-06-10T10:00:00.000Z',
      messages: [
        { role: 'system', content: 'СТАРАЯ СИСТЕМА' },
        { role: 'user', content: 'давний вопрос' },
      ],
    };
  }

  it('без switch/branch — новая ветка main с системой из конфига', () => {
    const session = resolveSession(fakeStore(), config, {}, undefined, undefined);
    assert.equal(session.messages.length, 1);
    assert.deepEqual(session.messages[0], { role: 'system', content: 'СИС' });
    assert.equal(session.label, 'main');
  });

  it('store=null (ephemeral) — всегда новая ветка', () => {
    const session = resolveSession(null, config, {}, 'last', undefined);
    assert.equal(session.messages[0].content, 'СИС');
  });

  it('switch=last без прошлых веток — новая', () => {
    const session = resolveSession(fakeStore(), config, {}, 'last', undefined);
    assert.equal(session.messages[0].content, 'СИС');
  });

  it('switch=last с существующей — продолжает её (система заморожена)', () => {
    const previous = existing('id-last');
    const session = resolveSession(fakeStore([previous]), config, {}, 'last', undefined);
    assert.equal(session.id, 'id-last');
    assert.equal(session.messages[0].content, 'СТАРАЯ СИСТЕМА'); // конфиг не влияет
  });

  it('switch по id, которого нет — бросает ошибку', () => {
    assert.throws(() => resolveSession(fakeStore(), config, {}, 'нет', undefined), /не найдена/);
  });

  it('switch по id — продолжает существующую', () => {
    const previous = existing('id-x');
    const session = resolveSession(fakeStore([previous]), config, {}, 'id-x', undefined);
    assert.equal(session.id, 'id-x');
  });

  it('switch по имени (label) — находит нужную ветку', () => {
    const previous = existing('id-y', 'alpha');
    const session = resolveSession(fakeStore([previous]), config, {}, 'alpha', undefined);
    assert.equal(session.id, 'id-y');
  });

  it('branch от switch-базы — копия сообщений с новым именем, оригинал цел', () => {
    const previous = existing('id-base', 'main');
    const session = resolveSession(fakeStore([previous]), config, {}, 'main', 'feature');

    assert.notEqual(session.id, 'id-base'); // другой id
    assert.equal(session.label, 'feature');
    assert.deepEqual(session.messages, previous.messages); // копия содержимого
    assert.notEqual(session.messages, previous.messages); // но не та же ссылка
  });

  it('branch без switch — ответвляется от последней ветки', () => {
    const previous = existing('id-latest', 'main');
    const session = resolveSession(fakeStore([previous]), config, {}, undefined, 'feature');
    assert.equal(session.label, 'feature');
    assert.deepEqual(session.messages, previous.messages);
  });

  it('branch с занятым именем — бросает ошибку', () => {
    const previous = existing('id-base', 'feature');
    assert.throws(
      () => resolveSession(fakeStore([previous]), config, {}, 'last', 'feature'),
      /уже существует/,
    );
  });

  it('branch без единой сессии — новая ветка с этим именем', () => {
    const session = resolveSession(fakeStore(), config, {}, undefined, 'feature');
    assert.equal(session.label, 'feature');
    assert.equal(session.messages[0].content, 'СИС'); // система из конфига
  });
});

describe('helpText / formatSessionList / newSession', () => {
  it('helpText содержит ключевые команды', () => {
    const text = helpText();
    assert.match(text, /\/sessions/);
    assert.match(text, /\/branch/);
    assert.match(text, /\/switch/);
    assert.match(text, /\/reset/);
  });

  it('formatSessionList: пусто, с именем ветки и с пустым превью', () => {
    assert.match(formatSessionList([]), /Сохранённых веток нет/);
    assert.match(
      formatSessionList([
        {
          id: 'a',
          model: 'm',
          label: 'main',
          createdAt: 't',
          updatedAt: 't',
          preview: 'вопрос',
          messageCount: 2,
        },
      ]),
      /main {2}\(a\) {2}вопрос/,
    );
    assert.match(
      formatSessionList([
        { id: 'b', model: 'm', createdAt: 't', updatedAt: 't', preview: '', messageCount: 1 },
      ]),
      /— {2}\(b\) {2}\(пусто\)/,
    );
  });

  it('newSession создаёт ветку main с системой из конфига', () => {
    const session = newSession(makeConfig({ model: 'glm', systemPrompt: 'СИС' }), {});
    assert.equal(session.model, 'glm');
    assert.equal(session.label, 'main');
    assert.deepEqual(session.messages, [{ role: 'system', content: 'СИС' }]);
  });
});

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
