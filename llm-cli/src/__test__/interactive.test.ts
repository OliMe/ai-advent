import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as readline from 'node:readline/promises';
import { PassThrough, Writable } from 'node:stream';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInteractive, type MemorySettings } from '../index.ts';
import {
  driveInteractive,
  clientWith,
  clientWithStream,
  taskRunClient,
  makeSession,
  makeCollector,
  fakeStore,
  storedSession,
  delay,
} from './helpers.ts';
import { ChatCompletionClient, createSession, summarizeTask } from '../../../core/src/index.ts';
import { makeConfig } from '../../../core/src/__test__/helpers.ts';
import type {
  ChatMessage,
  CompleteOptions,
  StreamDelta,
  Session,
  Task,
  TaskStore,
  Usage,
} from '../../../core/src/index.ts';

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

describe('интерактив: команды слоистой памяти', () => {
  const layered: MemorySettings = { enabled: true, profileStore: null, taskStore: null };

  it('/task создаёт задачу и сразу запускает её исполнение пайплайном', async t => {
    const client = taskRunClient(t);
    const { finished, text } = driveInteractive(
      client,
      ['/task Сделать лендинг', 'да', '/task', '/exit'],
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
    assert.match(text(), /Запущена задача «Сделать лендинг»/); // прогон стартовал сразу
    assert.match(text(), /завершена и подтверждена/); // дошёл до завершения по «да»
    assert.match(text(), /Активной задачи нет/); // после завершения задача отвязана
  });

  it('/tasks, /task switch и /task done', async t => {
    const client = taskRunClient(t);
    const { finished, text } = driveInteractive(
      client,
      [
        '/task Первая',
        'да', // подтверждаем завершение авто-прогона «Первая»
        '/task Вторая',
        'да', // и «Вторая»
        '/tasks',
        '/task switch Первая', // реактивируем завершённую
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
    const client = taskRunClient(t);
    const session = makeSession();
    const { finished, text } = driveInteractive(
      client,
      // switch реактивирует завершённую задачу и снова привязывает её к сессии —
      // тогда delete видит её активной и отвязывает.
      [
        '/task Черновик',
        'да',
        '/task switch Черновик',
        '/task delete Черновик',
        '/task delete нет',
        '/task',
        '/exit',
      ],
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
    assert.match(text(), /Удалено: «Черновик»/);
    assert.match(text(), /Задача не найдена: нет/);
    assert.match(text(), /Активной задачи нет/); // удалили активную — отвязалась
    assert.equal(session.taskId, undefined);
  });

  it('/task delete принимает несколько id/имён через запятую', async t => {
    const client = taskRunClient(t);
    const { finished, text } = driveInteractive(
      client,
      ['/task Один', 'да', '/task Два', 'да', '/task delete Один, Два, Нет', '/tasks', '/exit'],
      0.7,
      makeConfig(),
      true,
      fakeStore(),
      makeSession(),
      'window',
      6,
      layered,
    );
    await finished;
    assert.match(text(), /Удалено: «Один», «Два»\. Не найдены: Нет\./);
    assert.match(text(), /Задач пока нет/); // обе удалены
  });

  it('/profile forget принимает несколько номеров через запятую', async t => {
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
        return { content: 'OK', usage: undefined };
      },
    );
    t.mock.method(client, 'completeWithUsage', async (messages: ChatMessage[]) =>
      messages[0].content.includes('JSON')
        ? { content: '{"task":[],"user":["a","b","c"]}', usage: undefined }
        : { content: '', usage: undefined },
    );
    const { finished, text } = driveInteractive(
      client,
      ['привет', '/profile forget 1, 3', '/profile', '/exit'],
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
    assert.match(text(), /Забыто: a; c/); // удалены 1 и 3
    assert.match(text(), /1\. b/); // остался только b
  });

  it('/profile и /profile forget на пустом профиле', async t => {
    const client = clientWithStream(t, () => 'X');
    const { finished, text } = driveInteractive(
      client,
      ['/profile', '/profile forget 1', '/profile forget abc', '/exit'],
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
    assert.match(text(), /Профиль «default»: пуст/);
    assert.match(text(), /Нет таких пунктов профиля/);
  });

  it('/profiles и /profile switch: список, создание, переключение, текущий, без имени', async t => {
    const client = clientWithStream(t, () => 'X');
    const { finished, text } = driveInteractive(
      client,
      [
        '/profiles',
        '/profile switch работа',
        '/profile switch работа',
        '/profile switch default',
        '/profile switch',
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
    assert.match(text(), /Профили:/);
    assert.match(text(), /Создан и активирован профиль «работа»/);
    assert.match(text(), /Уже на профиле «работа»/);
    assert.match(text(), /Активный профиль: «default»/);
    assert.match(text(), /Укажите имя профиля/);
  });

  it('/profile rename и /profile delete', async t => {
    const client = clientWithStream(t, () => 'X');
    const { finished, text } = driveInteractive(
      client,
      [
        '/profile switch работа',
        '/profile rename job',
        '/profile rename job',
        '/profile switch второй',
        '/profile rename job',
        '/profile delete job, нет',
        '/profile rename',
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
    assert.match(text(), /Профиль переименован в «job»/);
    assert.match(text(), /Профиль уже называется «job»/);
    assert.match(text(), /Профиль «job» уже существует/);
    assert.match(text(), /Удалено: «job»\. Не найдены: нет\./);
    assert.match(text(), /Укажите новое имя/);
  });

  it('/profile delete существующего (без ненайденных)', async t => {
    const client = clientWithStream(t, () => 'X');
    const { finished, text } = driveInteractive(
      client,
      ['/profile switch temp', '/profile switch base', '/profile delete temp', '/exit'],
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
    assert.match(text(), /Удалено: «temp»\. Активный: «base»\./);
  });

  it('/profile delete несуществующего — «не найден»', async t => {
    const client = clientWithStream(t, () => 'X');
    const { finished, text } = driveInteractive(
      client,
      ['/profile delete нет', '/exit'],
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
    assert.match(text(), /Профиль не найден: нет/);
  });

  it('команды памяти при --no-memory сообщают, что она выключена', async t => {
    const client = clientWithStream(t, () => 'X');
    const { finished, text } = driveInteractive(
      client,
      [
        '/task X',
        '/tasks',
        '/profile',
        '/profile forget 1',
        '/task done',
        '/task switch Y',
        '/task delete Z',
        '/task',
        '/profiles',
        '/profile switch Z',
        '/profile rename Z',
        '/profile delete Z',
        '/invariants',
        '/invariant',
        '/invariant add X',
        '/invariant delete 1',
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

  it('инварианты: add / список / delete / показ', async t => {
    const client = clientWithStream(t, () => 'X');
    const { finished, text } = driveInteractive(
      client,
      [
        '/invariant',
        '/invariant add только нативный TS',
        '/invariant add только нативный TS',
        '/invariants',
        '/invariant delete 9',
        '/invariant delete 1',
        '/invariant',
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
    assert.match(text(), /Инвариантов нет/); // пустой список в начале
    assert.match(text(), /Инвариант добавлен: только нативный TS/);
    assert.match(text(), /Инвариант пуст или уже задан/); // дубль
    assert.match(text(), /Инварианты \(нарушать нельзя\):/);
    assert.match(text(), /Нет таких инвариантов/); // delete 9 — вне диапазона
    assert.match(text(), /Удалено: «только нативный TS»/);
  });

  it('инвариант: авто-предложение — «да» добавляет, «нет» отклоняет', async t => {
    const client = taskRunClient(t, {
      extraction: '{"task":[],"user":[],"invariant":"только PostgreSQL"}',
    });
    const accepted = driveInteractive(
      client,
      ['используем только PostgreSQL', 'да', '/invariants', '/exit'],
      0.7,
      makeConfig(),
      true,
      null,
      makeSession(),
      'window',
      6,
      layered,
    );
    await accepted.finished;
    assert.match(accepted.text(), /Сделать инвариантом «только PostgreSQL»\?/);
    assert.match(accepted.text(), /Инвариант добавлен: только PostgreSQL/);
    assert.match(accepted.text(), /1\. только PostgreSQL/); // виден в /invariants

    const declined = driveInteractive(
      taskRunClient(t, { extraction: '{"task":[],"user":[],"invariant":"только PostgreSQL"}' }),
      ['используем только PostgreSQL', 'нет', '/exit'],
      0.7,
      makeConfig(),
      true,
      null,
      makeSession(),
      'window',
      6,
      layered,
    );
    await declined.finished;
    assert.match(declined.text(), /Хорошо, без инварианта/);

    // Неявный ответ (не да/нет) — инвариант не ставится и не звучит «Хорошо».
    const implicit = driveInteractive(
      taskRunClient(t, { extraction: '{"task":[],"user":[],"invariant":"только PostgreSQL"}' }),
      ['используем только PostgreSQL', 'не знаю', '/invariants', '/exit'],
      0.7,
      makeConfig(),
      true,
      null,
      makeSession(),
      'window',
      6,
      layered,
    );
    await implicit.finished;
    assert.match(implicit.text(), /Сделать инвариантом «только PostgreSQL»\?/);
    assert.doesNotMatch(implicit.text(), /Хорошо, без инварианта/);
    assert.match(implicit.text(), /Инвариантов нет/); // не добавлен
  });

  it('инвариант: чат отказывается от решения, нарушающего инвариант', async t => {
    // Контролёр всегда находит нарушение → перегенерации исчерпаны → отказ.
    const client = taskRunClient(t, {
      check: '{"ok":false,"violations":["нарушает архитектуру"]}',
    });
    const { finished, text } = driveInteractive(
      client,
      ['/invariant add только нативный TS', 'добавь webpack-сборку', '/exit'],
      0.7,
      makeConfig(),
      false, // без стрима — проще
      null,
      makeSession(),
      'window',
      6,
      layered,
    );
    await finished;
    assert.match(text(), /контролёр: ответ нарушает инварианты/); // перегенерация
    assert.match(text(), /Не могу предложить решение: нарушает инвариант/); // отказ
  });

  it('инвариант: прерывание ввода на подтверждении завершает чат', async t => {
    const client = taskRunClient(t, {
      extraction: '{"task":[],"user":[],"invariant":"только PostgreSQL"}',
    });
    const input = new PassThrough();
    let buffer = '';
    let asked = false;
    const output = new Writable({
      write(chunk, _encoding, callback) {
        const text = chunk.toString();
        buffer += text;
        if (text.includes('Вы: ') && !asked) {
          asked = true;
          setImmediate(() => input.write('используем только PostgreSQL\n'));
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
    assert.match(buffer, /Сделать инвариантом «только PostgreSQL»\?/);
    assert.match(buffer, /До встречи!/);
  });

  it('стартовая задача (initialTaskTitle) и сохранение задач в хранилище', async t => {
    const client = taskRunClient(t);
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
      ['/task Вторая', 'да', '/task switch Старт', '/task done', '/exit'],
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
      ['Сделай сайт', '/profile forget 1', '/exit'],
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
    assert.match(text(), /Забыто: кратко/); // /profile forget удалил извлечённое предпочтение
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
    // Активная задача задаётся на старте (initialTaskTitle), без авто-прогона —
    // чтобы проверить накопление фактов в живой задаче во время обычного диалога.
    const { finished, text } = driveInteractive(
      client,
      ['добавь две цели', '/exit'],
      0.7,
      makeConfig(),
      true,
      null,
      makeSession(),
      'window',
      6,
      { enabled: true, profileStore: null, taskStore: null, initialTaskTitle: 'Сайт' },
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

  it('авто-задача: подтверждение «да» создаёт задачу и сразу запускает прогон', async t => {
    const client = taskRunClient(t, {
      extraction: '{"task":[],"user":[],"isNewTask":true,"proposedTitle":"Сбор ТЗ"}',
    });
    const { finished, text } = driveInteractive(
      client,
      // 1-е «да» — подтверждение задачи, 2-е — подтверждение завершения прогона.
      ['Собери ТЗ на приложение', 'да', 'да', '/task', '/exit'],
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
    assert.match(text(), /Запущена задача «Сбор ТЗ»/); // прогон вместо обычного ответа
    assert.match(text(), /завершена и подтверждена/);
    assert.doesNotMatch(text(), /Ассистент:/); // обычного ответа модели на сообщение нет
    assert.match(text(), /Активной задачи нет/); // после завершения задача отвязана
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

describe('runInteractive — команды прогонов задач (/run)', () => {
  const PLAN = JSON.stringify({ steps: ['шаг'], criteria: ['критерий'], text: 'план' });
  const EXEC = JSON.stringify({ summary: 'готово', log: [], text: 'результат' });
  const PASS = JSON.stringify({ passed: true, issues: [], text: 'ок' });
  const DONE = JSON.stringify({ summary: 'итог', text: 'резюме' });

  /** Клиент, отвечающий по персоне системного промпта (для агентов пайплайна). */
  function stageClient(t: TestContext, onStage?: (persona: string) => void): ChatCompletionClient {
    return clientWith(t, async messages => {
      const persona = messages[0]?.content ?? '';
      onStage?.(persona);
      if (persona.includes('планировщик')) return { content: PLAN, usage: undefined };
      if (persona.includes('исполнитель')) return { content: EXEC, usage: undefined };
      if (persona.includes('проверяющий')) return { content: PASS, usage: undefined };
      return { content: DONE, usage: undefined };
    });
  }

  it('маршрутизирует команды /run без активного прогона и без задачи', async t => {
    const client = stageClient(t);
    const { finished, text } = driveInteractive(client, [
      '/runs',
      '/run status',
      '/run continue',
      '/run edit правка',
      '/run abort',
      '/run',
      '/exit',
    ]);
    await finished;
    const out = text();
    assert.match(out, /Хранилище прогонов отключено/); // /runs при store=null
    assert.match(out, /Нет активного прогона/); // /run status, /run continue, /run edit, /run abort
    assert.match(out, /Нет текущей задачи/); // /run без аргумента и без текущей задачи
  });

  it('проходит весь пайплайн по /run и завершает по подтверждению', async t => {
    const client = stageClient(t);
    // С хранилищем сессий: мост синхронизирует session.taskId через store.save.
    const { finished, text } = driveInteractive(
      client,
      ['/run собери TODO-приложение', 'да', '/exit'],
      0.7,
      makeConfig(),
      true,
      fakeStore(),
    );
    await finished;
    const out = text();
    assert.match(out, /Запущена задача «собери TODO-приложение»/);
    assert.match(out, /планирование…/);
    assert.match(out, /Проверка пройдена ✓/);
    assert.match(out, /✓ Задача .* завершена и подтверждена/);
  });

  it('учитывает токены агентов прогона в сводке прогона и в итогах сессии', async t => {
    const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
    const client = clientWith(t, async messages => {
      const persona = messages[0]?.content ?? '';
      if (persona.includes('планировщик')) return { content: PLAN, usage };
      if (persona.includes('исполнитель')) return { content: EXEC, usage };
      if (persona.includes('проверяющий')) return { content: PASS, usage };
      return { content: DONE, usage };
    });
    const { finished, text } = driveInteractive(
      client,
      ['/run собери TODO-приложение', 'да', '/exit'],
      0.7,
      makeConfig(),
      true,
      fakeStore(),
    );
    await finished;
    const out = text();
    const run = out.match(/\[прогон · вход (\d+) · выход (\d+)/);
    assert.ok(run, 'есть строка расхода токенов прогона');
    assert.ok(Number(run[1]) > 0); // токены агентов прогона учтены
    // В этой сессии нет чат-реплик → итог сессии равен расходу прогона (пайплайн учтён).
    const session = out.match(/Итого за сессию: вход (\d+) · выход (\d+) · всего/);
    assert.ok(session);
    assert.equal(session[1], run[1]);
    assert.equal(session[2], run[2]);
  });

  it('Ctrl+C во время прогона ставит его на паузу, а не выходит', async t => {
    let captured: readline.Interface | undefined;
    const client = stageClient(t, persona => {
      if (persona.includes('планировщик')) captured?.emit('SIGINT');
    });
    const input = new PassThrough();
    const lines = ['/run сделай задачу', '/exit'];
    let next = 0;
    let buffer = '';
    const output = new Writable({
      write(chunk, _encoding, callback) {
        const chunkText = chunk.toString();
        buffer += chunkText;
        if (chunkText.includes('Вы: ') && next < lines.length) {
          const line = lines[next++];
          setImmediate(() => input.write(line + '\n'));
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
      () => {
        captured = readline.createInterface({ input, output });
        return captured;
      },
    );
    assert.match(buffer, /Пауза на этапе «выполнение»/);
    assert.match(buffer, /До встречи!/);
  });
});
