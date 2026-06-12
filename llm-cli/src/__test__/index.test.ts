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
  type MemoryKind,
} from '../index.ts';
import { ChatCompletionClient, createSession, summarize } from '../../../core/src/index.ts';
import type {
  AppConfig,
  ChatMessage,
  CompleteOptions,
  CompletionResult,
  StreamDelta,
  Session,
  SessionStore,
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

/** Сохранённая сессия с заданным id (для /resume и /fork). */
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
    stream,
    memory,
    session,
    store,
    input,
    output,
    readline.createInterface,
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

  it('стратегия summary: прогон сжатия помечается и учитывается в итогах', async t => {
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
    const config = makeConfig({ contextTokens: 300 }); // крошечный контекст → сжатие
    const big = 'а'.repeat(2000);

    const { finished, text } = driveInteractive(
      client,
      [big, big, '/exit'],
      0.7,
      config,
      true,
      null,
      makeSession(config),
      'summary',
    );
    await finished;

    assert.match(text(), /\[сжатие · вход 7 · выход 5/); // прогон сжатия помечен
    assert.match(text(), /Итого за сессию:/); // сжатие учтено в итогах
  });

  it('/help печатает список команд', async t => {
    const client = clientWithStream(t, () => 'X');
    const { finished, text } = driveInteractive(client, ['/help', '/exit']);
    await finished;

    assert.match(text(), /\/resume/);
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

    assert.match(text(), /Сохранённых сессий нет/);
  });

  it('/resume при --ephemeral сообщает об отключённом хранилище', async t => {
    const client = clientWithStream(t, () => 'X');
    const { finished, text } = driveInteractive(
      client,
      ['/resume любой', '/exit'],
      0.7,
      makeConfig(),
      true,
      null,
    );
    await finished;

    assert.match(text(), /отключено/);
  });

  it('/resume несуществующей сессии — «не найдена»', async t => {
    const client = clientWithStream(t, () => 'X');
    const { finished, text } = driveInteractive(
      client,
      ['/resume нет', '/exit'],
      0.7,
      makeConfig(),
      true,
      fakeStore(),
    );
    await finished;

    assert.match(text(), /не найдена: нет/);
  });

  it('/resume восстанавливает сессию по id', async t => {
    const client = clientWithStream(t, () => 'X');
    const { finished, text } = driveInteractive(
      client,
      ['/resume sess-1', '/exit'],
      0.7,
      makeConfig(),
      true,
      fakeStore([storedSession('sess-1')]),
    );
    await finished;

    assert.match(text(), /Восстановлена сессия sess-1/);
  });

  it('/fork ответвляется от сессии в новую', async t => {
    const client = clientWithStream(t, () => 'X');
    const { finished, text } = driveInteractive(
      client,
      ['/fork sess-2', '/exit'],
      0.7,
      makeConfig(),
      true,
      fakeStore([storedSession('sess-2')]),
    );
    await finished;

    assert.match(text(), /Ответвление от сессия sess-2/);
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

  it('--ephemeral и --fork — булевы; по умолчанию выключены', () => {
    assert.equal(parseArgs(['--ephemeral']).ephemeral, true);
    assert.equal(parseArgs(['--fork']).fork, true);
    const none = parseArgs(['привет']);
    assert.equal(none.ephemeral, false);
    assert.equal(none.fork, false);
    assert.equal(none.resume, undefined);
  });

  it('--resume без значения = last, с = задаёт id', () => {
    assert.equal(parseArgs(['--resume']).resume, 'last');
    assert.equal(parseArgs(['--resume=20260610T100000-ab']).resume, '20260610T100000-ab');
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

  it('--memory принимает window/summary; по умолчанию window', () => {
    assert.equal(parseArgs(['--memory=summary']).memory, 'summary');
    assert.equal(parseArgs(['--memory', 'window']).memory, 'window');
    assert.equal(parseArgs(['привет']).memory, 'window');
  });

  it('--memory отвергает иные значения', () => {
    assert.throws(() => parseArgs(['--memory=foo']), /window или summary/);
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
      new ChatCompletionClient(makeConfig()),
      5000,
    );
    const messages = [sys, big('user', 1), big('assistant', 1)];
    assert.deepEqual(await strategy.prepare(messages), trimHistoryToBudget(messages, 10_000));
    strategy.reset(); // no-op, не падает
  });

  it('summary: всё влезает — без сжатия, резюме не добавляется', async t => {
    const client = clientWith(t, async () => ({ content: 'не-нужно', usage: undefined }));
    const strategy = createMemoryStrategy('summary', 10_000, client, 5000);
    const result = await strategy.prepare([sys, big('user', 1)]);

    assert.deepEqual(
      result.map(m => m.role),
      ['system', 'user'],
    );
    assert.ok(!result.some(m => m.content.includes('Краткое содержание')));
  });

  it('summary: только система — пустой pending', async t => {
    const client = clientWith(t, async () => ({ content: 'x', usage: undefined }));
    const strategy = createMemoryStrategy('summary', 1000, client, 5000);
    assert.deepEqual(await strategy.prepare([sys]), [sys]);
  });

  it('summary: старые реплики сворачиваются в системное резюме (два прогона)', async t => {
    let folds = 0;
    const client = clientWith(t, async () => {
      folds++;
      return {
        content: 'РЕЗ',
        usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
      };
    });
    const strategy = createMemoryStrategy('summary', 60, client, 5000);
    const compressions: (Usage | undefined)[] = [];
    const messages = [sys, big('user', 1), big('assistant', 1), big('user', 2)];

    const result = await strategy.prepare(messages, u => compressions.push(u));

    assert.equal(result[0], sys); // система первой
    assert.equal(result[1].role, 'system'); // резюме как system-сообщение
    assert.match(result[1].content, /Краткое содержание/);
    assert.ok(result.some(m => m.content.startsWith('user-2'))); // свежая реплика на месте
    assert.equal(folds, 2); // свёрнуто в два прогона (user и assistant)
    assert.equal(compressions.length, 2);
  });

  it('summary: без onCompression тоже сворачивает', async t => {
    const client = clientWith(t, async () => ({ content: 'РЕЗ', usage: undefined }));
    const strategy = createMemoryStrategy('summary', 80, client, 5000);
    const messages = [sys, big('user', 1), big('assistant', 1), big('user', 2)];
    const result = await strategy.prepare(messages); // onCompression не передан
    assert.match(result[1].content, /Краткое содержание/);
  });

  it('summary: при сбое сжатия откатывается к окну', async t => {
    const client = clientWith(t, async () => {
      throw new Error('сжатие упало');
    });
    const strategy = createMemoryStrategy('summary', 80, client, 5000);
    const messages = [sys, big('user', 1), big('assistant', 1), big('user', 2)];
    assert.deepEqual(await strategy.prepare(messages), trimHistoryToBudget(messages, 80));
  });

  it('summary: reset() очищает резюме', async t => {
    const client = clientWith(t, async () => ({ content: 'РЕЗ', usage: undefined }));
    const strategy = createMemoryStrategy('summary', 80, client, 5000);
    const messages = [sys, big('user', 1), big('assistant', 1), big('user', 2)];
    await strategy.prepare(messages); // создаём резюме
    strategy.reset();
    const after = await strategy.prepare([sys, big('user', 1)]); // мало → без резюме
    assert.ok(!after.some(m => m.content.includes('Краткое содержание')));
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
});

describe('resolveSession', () => {
  const config = makeConfig({ model: 'glm', systemPrompt: 'СИС' });

  /** Существующая сессия для подмены в хранилище. */
  function existing(id: string): Session {
    return {
      version: 1,
      id,
      model: 'other',
      createdAt: '2026-06-10T10:00:00.000Z',
      updatedAt: '2026-06-10T10:00:00.000Z',
      messages: [
        { role: 'system', content: 'СТАРАЯ СИСТЕМА' },
        { role: 'user', content: 'давний вопрос' },
      ],
    };
  }

  it('без resume — новая сессия с системой из конфига', () => {
    const session = resolveSession(fakeStore(), config, {}, undefined, false);
    assert.equal(session.messages.length, 1);
    assert.deepEqual(session.messages[0], { role: 'system', content: 'СИС' });
  });

  it('store=null (ephemeral) — всегда новая сессия', () => {
    const session = resolveSession(null, config, {}, 'last', false);
    assert.equal(session.messages[0].content, 'СИС');
  });

  it('resume=last без прошлых сессий — новая', () => {
    const session = resolveSession(fakeStore(), config, {}, 'last', false);
    assert.equal(session.messages[0].content, 'СИС');
  });

  it('resume=last с существующей — продолжает её (система заморожена)', () => {
    const previous = existing('id-last');
    const session = resolveSession(fakeStore([previous]), config, {}, 'last', false);
    assert.equal(session.id, 'id-last');
    assert.equal(session.messages[0].content, 'СТАРАЯ СИСТЕМА'); // конфиг не влияет
  });

  it('resume по id, которого нет — бросает ошибку', () => {
    assert.throws(() => resolveSession(fakeStore(), config, {}, 'нет', false), /не найдена/);
  });

  it('resume по id — продолжает существующую', () => {
    const previous = existing('id-x');
    const session = resolveSession(fakeStore([previous]), config, {}, 'id-x', false);
    assert.equal(session.id, 'id-x');
  });

  it('fork — новая сессия с копией сообщений, оригинал не меняется', () => {
    const previous = existing('id-fork');
    const session = resolveSession(fakeStore([previous]), config, {}, 'id-fork', true);

    assert.notEqual(session.id, 'id-fork'); // другой id
    assert.deepEqual(session.messages, previous.messages); // копия содержимого
    assert.notEqual(session.messages, previous.messages); // но не та же ссылка
  });
});

describe('helpText / formatSessionList / newSession', () => {
  it('helpText содержит ключевые команды', () => {
    const text = helpText();
    assert.match(text, /\/sessions/);
    assert.match(text, /\/fork/);
    assert.match(text, /\/reset/);
  });

  it('formatSessionList: пусто, с превью и с пустым превью', () => {
    assert.match(formatSessionList([]), /Сохранённых сессий нет/);
    assert.match(
      formatSessionList([
        { id: 'a', model: 'm', createdAt: 't', updatedAt: 't', preview: 'вопрос', messageCount: 2 },
      ]),
      /a {2}вопрос/,
    );
    assert.match(
      formatSessionList([
        { id: 'b', model: 'm', createdAt: 't', updatedAt: 't', preview: '', messageCount: 1 },
      ]),
      /\(пусто\)/,
    );
  });

  it('newSession создаёт сессию с системой из конфига', () => {
    const session = newSession(makeConfig({ model: 'glm', systemPrompt: 'СИС' }), {});
    assert.equal(session.model, 'glm');
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
