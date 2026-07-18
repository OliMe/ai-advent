import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Conversation, createRun, createTask } from '../../../core/src/index.ts';
import type {
  ProjectContext,
  ProjectCommandRunner,
  RunStore,
  RunSummary,
  Stage,
  Task,
  TaskRun,
  ToolSet,
} from '../../../core/src/index.ts';
import {
  RunController,
  makeConversationFactory,
  parseClarifierStep,
  type ConversationFactory,
  type RunTaskBridge,
} from '../run-flow.ts';
import type { WorkspaceIo } from '../run-workspace.ts';
import { clientWith, makeCollector } from './helpers.ts';
import { makeConfig } from '../../../core/src/__test__/helpers.ts';

const PLAN = JSON.stringify({ steps: ['шаг'], criteria: ['критерий'], text: 'план' });
const EXEC = JSON.stringify({ summary: 'готово', log: [], text: 'результат' });
const PASS = JSON.stringify({ passed: true, issues: [], text: 'ок' });
const FAIL = JSON.stringify({ passed: false, issues: ['нет тестов'], text: 'плохо' });
const DONE = JSON.stringify({ summary: 'итог', text: 'резюме' });

type StageContent = Record<Stage, () => string>;

function stageOf(systemPrompt: string): Stage {
  if (systemPrompt.includes('планировщик')) return 'planning';
  if (systemPrompt.includes('исполнитель')) return 'execution';
  if (systemPrompt.includes('проверяющий')) return 'verification';
  return 'completion';
}

function content(over: Partial<StageContent> = {}): StageContent {
  return {
    // requirements не ходит через makeConversation (это интерактивный хук) — заглушка.
    requirements: () => '',
    planning: () => PLAN,
    execution: () => EXEC,
    verification: () => PASS,
    completion: () => DONE,
    ...over,
  };
}

interface FactoryHooks {
  onStage?: (stage: Stage) => void;
  onPrompt?: (stage: Stage, prompt: string) => void;
  /** Ловит промпт каждого хода аналитика (для проверки адаптивности). */
  onClarifier?: (prompt: string) => void;
  /** Ловит температуру диалога аналитика (для проверки её значения). */
  onClarifierTemp?: (temperature: number | undefined) => void;
}

/**
 * Фабрика диалогов: этапы отвечают по персоне; агент-аналитик (сбор требований) —
 * последовательностью ответов `clarifier` (ход за ходом; по умолчанию сразу «готово»).
 * Ловит этап/промпт.
 */
function factory(
  t: TestContext,
  by: StageContent,
  hooks: FactoryHooks = {},
  clarifier: string[] = ['{"done":true}'],
): ConversationFactory {
  return (systemPrompt, limits, temperature) => {
    const isClarifier = systemPrompt.includes('аналитик требований');
    if (isClarifier) hooks.onClarifierTemp?.(temperature);
    const stage = stageOf(systemPrompt);
    let clarifierTurn = 0;
    const client = clientWith(t, async messages => {
      const lastPrompt = messages.at(-1)?.content ?? '';
      if (isClarifier) {
        hooks.onClarifier?.(lastPrompt);
        const reply = clarifier[Math.min(clarifierTurn, clarifier.length - 1)];
        clarifierTurn++;
        return { content: reply, usage: undefined };
      }
      hooks.onStage?.(stage);
      hooks.onPrompt?.(stage, lastPrompt);
      return { content: by[stage](), usage: undefined };
    });
    return new Conversation(client, {
      systemPrompt,
      temperature: 0.5,
      contextTokens: 8192,
      requestTimeoutMs: 5000,
      limits,
    });
  };
}

/** Хранилище-заглушка прогонов: снимок на каждом save + журнал артефактов. */
function fakeStore(seed: TaskRun[] = []): RunStore & { saved: TaskRun[] } {
  const map = new Map(seed.map(run => [run.id, run]));
  const saved: TaskRun[] = [];
  return {
    saved,
    list: (): RunSummary[] =>
      [...map.values()].map(run => ({
        id: run.id,
        title: run.title,
        stage: run.stage,
        status: run.status,
        updatedAt: run.updatedAt,
      })),
    load: id => map.get(id) ?? null,
    save: run => {
      saved.push(structuredClone(run));
      map.set(run.id, run);
    },
    delete: id => void map.delete(id),
    writeArtifact: (runId, name) => `/runs/${runId}/${name}`,
  };
}

/** Ответы пользователя на подтверждение завершения (по очереди). */
function answers(queue: string[]): (prompt: string) => Promise<string> {
  let index = 0;
  return async () => queue[index++] ?? 'да';
}

/** Мост-заглушка к задаче + журналы вызовов. */
function fakeBridge(opts: { task?: Task | null; context?: string } = {}) {
  const task = 'task' in opts ? (opts.task ?? null) : createTask('Задача');
  const completed: string[] = [];
  const adopted: string[] = [];
  const created: string[] = [];
  const details: string[] = [];
  const bridge: RunTaskBridge = {
    current: () => task,
    resolveOrCreate: arg => {
      created.push(arg);
      return createTask(arg);
    },
    adopt: id => void adopted.push(id),
    addDetail: text => void details.push(text),
    memoryContext: () => opts.context ?? '',
    complete: summary => {
      completed.push(summary);
      return task !== null;
    },
  };
  return { bridge, completed, adopted, created, details };
}

describe('makeConversationFactory', () => {
  it('строит диалог с системным промптом первым сообщением', t => {
    const make = makeConversationFactory(
      clientWith(t, async () => ({ content: '' })),
      makeConfig(),
      true,
      0.3,
    );
    const conversation = make('СИСТЕМА');
    assert.equal(conversation.messages[0]?.content, 'СИСТЕМА');
  });

  it('применяет stageMaxTokens из конфига; явный limits имеет приоритет', async t => {
    let captured: { maxTokens?: number } = {};
    const make = makeConversationFactory(
      clientWith(t, async (_messages, options) => {
        captured = options;
        return { content: '' };
      }),
      makeConfig({ stageMaxTokens: 1234 }),
      true,
      0.3,
    );
    await make('S').ask('привет');
    assert.equal(captured.maxTokens, 1234); // потолок из конфига

    await make('S', { maxTokens: 50 }).ask('привет');
    assert.equal(captured.maxTokens, 50); // явный limits перекрывает конфиг
  });

  it('применяет температуру этапа (override), иначе общую', async t => {
    let captured: { temperature?: number } = {};
    const make = makeConversationFactory(
      clientWith(t, async (_messages, options) => {
        captured = options;
        return { content: '' };
      }),
      makeConfig(),
      true,
      0.7,
    );
    await make('S').ask('привет');
    assert.equal(captured.temperature, 0.7); // общая температура

    await make('S', undefined, 0).ask('привет');
    assert.equal(captured.temperature, 0); // этап задал свою (напр. проверяющий)
  });

  it('пробрасывает maxToolRounds из конфига (иначе этап упрётся в дефолт 6)', async t => {
    let rounds = 0;
    const tools: ToolSet = {
      specs: () => [{ name: 't', description: 'd', parameters: {} }],
      call: async () => 'ok',
    };
    const make = makeConversationFactory(
      clientWith(t, async () => {
        rounds++;
        return {
          content: '',
          toolCalls: [{ id: `c${rounds}`, type: 'function', function: { name: 't', arguments: '{}' } }],
        };
      }),
      makeConfig({ maxToolRounds: 3 }),
      true,
      0.3,
    );
    // Инструмент зовётся бесконечно → цикл упрётся в потолок из конфига (3), а не в дефолт (6).
    await assert.rejects(
      make('S', undefined, undefined, tools).ask('го'),
      /Превышен лимит раундов вызова инструментов \(3\)/,
    );
    assert.equal(rounds, 3);
  });
});

describe('parseClarifierStep', () => {
  it('разбирает вопрос+подсказку, done и фолбэки', () => {
    assert.deepEqual(parseClarifierStep('{"question":" Бюджет? ","suggestion":" 100к "}'), {
      done: false,
      question: 'Бюджет?',
      suggestion: '100к',
    });
    assert.deepEqual(parseClarifierStep('{"question":"Сроки?"}'), {
      done: false,
      question: 'Сроки?',
      suggestion: '', // подсказки нет
    });
    assert.deepEqual(parseClarifierStep('{"done":true}'), { done: true });
    assert.deepEqual(parseClarifierStep('{"question":""}'), { done: true }); // пустой вопрос = готово
    assert.deepEqual(parseClarifierStep('{}'), { done: true }); // нет полей
    assert.deepEqual(parseClarifierStep('не json'), { done: true }); // битый JSON
    // JSON, обёрнутый прозой (без response_format), всё равно разбирается.
    assert.deepEqual(parseClarifierStep('Вопрос: {"question":"Бюджет?","suggestion":"100к"}'), {
      done: false,
      question: 'Бюджет?',
      suggestion: '100к',
    });
  });
});

describe('RunController', () => {
  it('адаптивный опрос: вопросы по одному, пустой ответ принимает предложение', async t => {
    const out = makeCollector();
    const { bridge, details } = fakeBridge();
    const clarifierPrompts: string[] = [];
    const clarifierTemps: (number | undefined)[] = [];
    const askPrompts: string[] = [];
    const queue = ['бюджет 100к', '', 'да']; // 1-й вопрос; пустой (примет предложение); подтверждение
    let answerIndex = 0;
    const controller = new RunController({
      store: fakeStore(),
      makeConversation: factory(
        t,
        content(),
        {
          onClarifier: p => clarifierPrompts.push(p),
          onClarifierTemp: temp => clarifierTemps.push(temp),
        },
        [
          '{"question":"Какой бюджет?","suggestion":"100к"}',
          '{"question":"Какие сроки?","suggestion":"месяц"}',
          '{"done":true}',
        ],
      ),
      output: out.stream,
      ask: async prompt => {
        askPrompts.push(prompt);
        return queue[answerIndex++] ?? 'да';
      },
      taskBridge: bridge,
    });
    await controller.start('Лендинг');
    const text = out.text();
    assert.match(text, /уточнение требований…/);
    // Подсказка идёт в приглашение readline (его печатает реальный CLI), не в общий вывод.
    assert.match(askPrompts.join('\n'), /предлагаемый ответ: 100к; Enter — принять/);
    assert.match(text, /Требования собраны и записаны в задачу/);
    assert.deepEqual(details, [
      'Требование: Какой бюджет? → бюджет 100к',
      'Требование: Какие сроки? → месяц', // пустой ответ принял предложение
    ]);
    // Следующий вопрос задаётся с учётом предыдущего ответа (адаптивность).
    assert.match(clarifierPrompts[1] ?? '', /Ответ пользователя: бюджет 100к/);
    assert.match(text, /завершена и подтверждена/);
    // Аналитик идёт на низко-умеренной температуре (0.3), а не на сессионной.
    assert.ok(clarifierTemps.length > 0 && clarifierTemps.every(temp => temp === 0.3));
  });

  it('опрос требований: слово-стоп завершает сбор досрочно', async t => {
    const out = makeCollector();
    const { bridge, details } = fakeBridge();
    const controller = new RunController({
      store: fakeStore(),
      makeConversation: factory(t, content(), {}, [
        '{"question":"Какой бюджет?","suggestion":"100к"}',
        '{"question":"Какие сроки?","suggestion":"месяц"}',
      ]),
      output: out.stream,
      ask: answers(['бюджет 100к', 'достаточно', 'да']), // 2-й ответ — стоп-слово
      taskBridge: bridge,
    });
    await controller.start('Лендинг');
    assert.deepEqual(details, ['Требование: Какой бюджет? → бюджет 100к']); // стоп прервал опрос
    assert.match(out.text(), /завершена и подтверждена/);
  });

  it('нет вопросов аналитика → опрос пропускается', async t => {
    const out = makeCollector();
    const { details } = fakeBridge();
    const controller = new RunController({
      store: fakeStore(),
      makeConversation: factory(t, content()), // clarifier по умолчанию: вопросов нет
      output: out.stream,
      ask: answers(['да']),
      taskBridge: fakeBridge().bridge,
    });
    await controller.start('Задача');
    assert.doesNotMatch(out.text(), /уточнение требований/);
    assert.deepEqual(details, []);
  });

  it('сбой аналитика не блокирует прогон', async t => {
    const out = makeCollector();
    const make: ConversationFactory = (systemPrompt, limits) => {
      const isClarifier = systemPrompt.includes('аналитик требований');
      const client = clientWith(t, async () => {
        if (isClarifier) throw new Error('аналитик упал');
        return { content: content()[stageOf(systemPrompt)](), usage: undefined };
      });
      return new Conversation(client, {
        systemPrompt,
        temperature: 0.5,
        contextTokens: 8192,
        requestTimeoutMs: 5000,
        limits,
      });
    };
    const controller = new RunController({
      store: fakeStore(),
      makeConversation: make,
      output: out.stream,
      ask: answers(['да']),
      taskBridge: fakeBridge().bridge,
    });
    await controller.start('Задача');
    const text = out.text();
    assert.match(text, /\[уточнение пропущено\] аналитик упал/);
    assert.match(text, /завершена и подтверждена/);
  });

  it('опрос требований прерывается по Ctrl+C → пауза на сборе требований', async t => {
    const out = makeCollector();
    const { details } = fakeBridge();
    let controller: RunController;
    controller = new RunController({
      store: fakeStore(),
      makeConversation: factory(t, content(), {}, [
        '{"question":"Q1","suggestion":"s1"}',
        '{"question":"Q2","suggestion":"s2"}',
      ]),
      output: out.stream,
      ask: async () => {
        controller.requestPause(); // пауза после первого вопроса
        return 'ответ';
      },
      taskBridge: { ...fakeBridge().bridge, addDetail: text => void details.push(text) },
    });
    await controller.start('Задача');
    assert.equal(details.length, 1); // второй вопрос не задан (прервано)
    assert.match(out.text(), /Пауза на этапе «сбор требований»/);
  });

  it('многоагентное планирование: команда печатается, вклады в результате этапа', async t => {
    const out = makeCollector();
    // Диалоги отвечают по персоне: оркестратор → команда из 2 ролей, синтезатор → план.
    const make: ConversationFactory = (systemPrompt, limits) => {
      const client = clientWith(t, async () => {
        // Кларификатор — по полной фразе: «аналитик требований» (а не подстроке
        // «аналитик», которая теперь встречается и в промпте оркестратора — «аналитика»).
        if (systemPrompt.includes('аналитик требований')) {
          return { content: '{"done":true}', usage: undefined };
        }
        if (systemPrompt.includes('оркестратор команды')) {
          return {
            content:
              '{"roles":[{"name":"архитектор","focus":"структура"},' +
              '{"name":"безопасность","focus":"риски"}],"rationale":"сложная система"}',
            usage: undefined,
          };
        }
        if (systemPrompt.includes('в команде планирования')) {
          return { content: '- предложение роли', usage: undefined };
        }
        if (systemPrompt.includes('ведущий планировщик')) {
          return { content: PLAN, usage: undefined };
        }
        if (systemPrompt.includes('исполнитель')) {
          return { content: EXEC, usage: undefined };
        }
        if (systemPrompt.includes('проверяющий')) {
          return { content: PASS, usage: undefined };
        }
        return { content: DONE, usage: undefined };
      });
      return new Conversation(client, {
        systemPrompt,
        temperature: 0.5,
        contextTokens: 8192,
        requestTimeoutMs: 5000,
        limits,
      });
    };
    const controller = new RunController({
      store: fakeStore(),
      makeConversation: make,
      output: out.stream,
      ask: answers(['да']),
      taskBridge: fakeBridge().bridge,
      teamConfig: { maxAgents: 3, concurrency: 2 },
    });
    await controller.start('Сложная система');
    const text = out.text();
    assert.match(text, /Команда на этап «планирование»: архитектор \(структура\), безопасность/);
    assert.match(text, /сложная система/); // обоснование оркестратора
    assert.match(text, /Вклады ролей команды:/); // вклады ролей в результате этапа
    assert.match(text, /• архитектор:/); // виден вклад конкретной роли
    assert.match(text, /завершена и подтверждена/);
  });

  it('continue несогласованного прогона откатывает этап и сообщает (без проскока)', async t => {
    const out = makeCollector();
    // Повреждённый/правленый прогон: стоит на completion без артефактов.
    const broken: TaskRun = {
      ...createRun('Задача', { idSuffix: 'rep' }),
      stage: 'completion',
      status: 'paused',
    };
    const controller = new RunController({
      store: fakeStore([broken]),
      makeConversation: factory(t, content()),
      output: out.stream,
      ask: answers(['да']),
      taskBridge: fakeBridge().bridge,
    });
    await controller.continue(broken.id);
    const text = out.text();
    assert.match(text, /состояние не согласовано/);
    assert.match(text, /перепрыгнуть этап нельзя/);
    assert.match(text, /завершена и подтверждена/); // прошёл все этапы заново
  });

  it('start без аргумента и без текущей задачи подсказывает', async t => {
    const out = makeCollector();
    const controller = new RunController({
      store: null,
      makeConversation: factory(t, content()),
      output: out.stream,
      ask: answers([]),
      taskBridge: fakeBridge({ task: null }).bridge,
    });
    await controller.start('');
    assert.match(out.text(), /Нет текущей задачи/);
  });

  it('happy path: исполняет задачу и пишет итог обратно в память', async t => {
    const out = makeCollector();
    const store = fakeStore();
    const { bridge, completed } = fakeBridge();
    const controller = new RunController({
      store,
      makeConversation: factory(t, content()),
      output: out.stream,
      ask: answers(['да']),
      taskBridge: bridge,
    });
    await controller.start('Задача');
    const text = out.text();
    assert.match(text, /Запущена задача «Задача»/);
    assert.match(text, /планирование…/);
    assert.match(text, /результат/); // полный текст этапа выполнения, не однострочник
    assert.match(text, /Проверка пройдена ✓/);
    assert.match(text, /✓ Задача «Задача» завершена и подтверждена\. Итог записан в память задачи/);
    assert.deepEqual(completed, ['итог']); // итог отдан мосту
    assert.ok(store.saved.some(run => run.status === 'completed'));
    assert.ok(store.saved.some(run => run.taskId !== undefined)); // прогон связан с задачей
  });

  it('пишет результат каждого этапа в транскрипт сессии', async t => {
    const out = makeCollector();
    const recorded: Array<{ role: string; content: string }> = [];
    const controller = new RunController({
      store: fakeStore(),
      makeConversation: factory(t, content()),
      output: out.stream,
      ask: answers(['да']),
      taskBridge: fakeBridge().bridge,
      recordToSession: (role, content) => recorded.push({ role, content }),
    });
    await controller.start('Задача');
    // Весь нарратив прогона пишется как 'assistant' (никогда не 'user' — иначе утечёт
    // в консолидацию профиля): уведомление о запуске + по сообщению на каждый из 5 этапов.
    assert.ok(recorded.every(entry => entry.role === 'assistant'));
    assert.match(recorded[0]?.content ?? '', /Запуск задачи по этапам/);
    const stages = recorded.filter(entry => /^\[/.test(entry.content)); // записи этапов: «[метка]…»
    assert.equal(stages.length, 5);
    assert.match(stages[0].content, /\[сбор требований\]/);
    assert.match(stages[1].content, /\[планирование\]/);
    assert.match(stages[4].content, /\[завершение\]/);
  });

  it('start с описанием создаёт/находит задачу через мост', async t => {
    const out = makeCollector();
    const { bridge, created } = fakeBridge();
    const controller = new RunController({
      store: fakeStore(),
      makeConversation: factory(t, content()),
      output: out.stream,
      ask: answers(['да']),
      taskBridge: bridge,
    });
    await controller.start('собрать лендинг');
    assert.deepEqual(created, ['собрать лендинг']);
    assert.match(out.text(), /Запущена задача «собрать лендинг»/);
  });

  it('подаёт память задачи в промпт планирования', async t => {
    const out = makeCollector();
    let planPrompt = '';
    const controller = new RunController({
      store: fakeStore(),
      makeConversation: factory(t, content(), {
        onPrompt: (stage, prompt) => {
          if (stage === 'planning') planPrompt = prompt;
        },
      }),
      output: out.stream,
      ask: answers(['да']),
      taskBridge: fakeBridge({ context: 'Контекст задачи:\n- бюджет 100к' }).bridge,
    });
    await controller.start('Задача');
    assert.match(planPrompt, /бюджет 100к/);
  });

  it('аналитик требований получает карточку проекта (не переспрашивает про корень/файлы)', async t => {
    const clarifierPrompts: string[] = [];
    const controller = new RunController({
      store: fakeStore(),
      makeConversation: factory(t, content(), { onClarifier: p => clarifierPrompts.push(p) }, [
        '{"question":"Что именно актуализировать?","suggestion":"описание"}',
        '{"done":true}',
      ]),
      output: makeCollector().stream,
      ask: answers(['', 'да']), // принять предложение аналитика, затем подтвердить завершение
      taskBridge: fakeBridge().bridge,
      projectContext: () => 'Проект «entry-forms»\n- корень: /repo',
    });
    await controller.start('Актуализируй README');
    assert.ok(clarifierPrompts.length > 0);
    assert.match(clarifierPrompts[0], /Проект «entry-forms»/); // карточка проекта ушла аналитику
  });

  it('провал проверки → авто-возврат в выполнение, затем успех', async t => {
    const out = makeCollector();
    let verifyCalls = 0;
    const controller = new RunController({
      store: fakeStore(),
      makeConversation: factory(
        t,
        content({ verification: () => (++verifyCalls === 1 ? FAIL : PASS) }),
      ),
      output: out.stream,
      ask: answers(['да']),
      taskBridge: fakeBridge().bridge,
    });
    await controller.start('Задача');
    const text = out.text();
    assert.match(text, /возврат в выполнение \(проверка не пройдена\), попытка 1/);
    assert.match(text, /завершена и подтверждена/);
  });

  it('--ephemeral (store=null): завершается без записи на диск', async t => {
    const out = makeCollector();
    const controller = new RunController({
      store: null,
      makeConversation: factory(t, content()),
      output: out.stream,
      ask: answers(['да']),
      taskBridge: fakeBridge().bridge,
    });
    await controller.start('Задача');
    assert.match(out.text(), /завершена и подтверждена/);
  });

  it('отказ с правкой → возврат в выполнение, затем подтверждение', async t => {
    const out = makeCollector();
    const controller = new RunController({
      store: fakeStore(),
      makeConversation: factory(t, content()),
      output: out.stream,
      ask: answers(['доделай как следует', 'да']),
      taskBridge: fakeBridge().bridge,
    });
    await controller.start('Задача');
    const text = out.text();
    assert.match(text, /возврат в выполнение \(не подтверждено\), попытка 1/);
    assert.match(text, /завершена и подтверждена/);
  });

  it('явный отказ «нет» → возврат без правки', async t => {
    const out = makeCollector();
    const controller = new RunController({
      store: fakeStore(),
      makeConversation: factory(t, content()),
      output: out.stream,
      ask: answers(['нет', 'да']),
      taskBridge: fakeBridge().bridge,
    });
    await controller.start('Задача');
    assert.match(out.text(), /попытка 1/);
  });

  it('отказ на завершении исчерпал лимит → пауза (continue связывает задачу)', async t => {
    const run = createRun('Задача', { maxRetries: 0, idSuffix: 'x', taskId: 't1' });
    const out = makeCollector();
    const { bridge, adopted } = fakeBridge();
    const controller = new RunController({
      store: fakeStore([run]),
      makeConversation: factory(t, content()), // проверка проходит, пауза — из-за отказа
      output: out.stream,
      ask: answers(['нет']), // отказ на завершении при maxRetries=0 → пауза
      taskBridge: bridge,
    });
    await controller.continue(run.id);
    const text = out.text();
    assert.deepEqual(adopted, ['t1']); // задача прогона стала текущей
    assert.match(text, /Продолжаем «Задача» с этапа «сбор требований»/);
    assert.match(text, /Лимит авто-возвратов \(0\) исчерпан/);
  });

  it('лимит проверок исчерпан → возврат к сбору требований, счётчик сброшен', async t => {
    const run = createRun('Задача', { maxRetries: 1, idSuffix: 'rp', taskId: 't1' });
    const out = makeCollector();
    let verifyCalls = 0;
    const controller = new RunController({
      store: fakeStore([run]),
      // На каждом цикле сбора аналитик задаёт по вопросу; проверка валит дважды
      // (1 ретрай + возврат к требованиям), после повторного сбора — успех.
      makeConversation: factory(
        t,
        content({ verification: () => (++verifyCalls <= 2 ? FAIL : PASS) }),
        {},
        ['{"question":"Уточни масштаб?","suggestion":"малый"}', '{"done":true}'],
      ),
      output: out.stream,
      ask: answers(['малый', 'малый', 'да']), // ответы на вопрос в обоих циклах + подтверждение
      taskBridge: fakeBridge().bridge,
    });
    await controller.continue(run.id);
    const text = out.text();
    assert.match(text, /возврат в выполнение \(проверка не пройдена\), попытка 1/);
    assert.match(text, /лимит проверок \(1\) исчерпан — возврат к сбору требований \(цикл 1\/3\)/);
    assert.match(text, /уточнение требований \(повтор, цикл 1\)…/); // заголовок повторного сбора
    assert.match(text, /завершена и подтверждена/);
  });

  it('пустой ответ без подсказки — вопрос пропущен, опрос продолжается', async t => {
    const out = makeCollector();
    const { bridge, details } = fakeBridge();
    const controller = new RunController({
      store: fakeStore(),
      makeConversation: factory(t, content(), {}, [
        '{"question":"Любые ограничения?"}', // без suggestion
        '{"done":true}',
      ]),
      output: out.stream,
      ask: answers(['', 'да']), // пустой ответ на вопрос без подсказки → не записан
      taskBridge: bridge,
    });
    await controller.start('Задача');
    assert.deepEqual(details, []); // пустой ответ без подсказки ничего не записал
    assert.match(out.text(), /завершена и подтверждена/);
  });

  it('исчерпан лимит циклов сбора требований → пауза', async t => {
    const run = createRun('Задача', {
      maxRetries: 0,
      maxRequirementCycles: 1,
      idSuffix: 'rc',
      taskId: 't1',
    });
    const out = makeCollector();
    const controller = new RunController({
      store: fakeStore([run]),
      makeConversation: factory(t, content({ verification: () => FAIL })),
      output: out.stream,
      ask: answers([]),
      taskBridge: fakeBridge().bridge,
    });
    await controller.continue(run.id);
    assert.match(out.text(), /Исчерпан лимит циклов сбора требований \(1\)/);
  });

  it('инвариант: контролёр блокирует решающий этап → пауза, нарушение названо', async t => {
    const out = makeCollector();
    // Контролёр всегда находит нарушение; аналитик завершает сразу; этапы — штатно.
    const make: ConversationFactory = systemPrompt => {
      const reply = systemPrompt.includes('контролёр')
        ? '{"ok":false,"violations":["нарушает выбранную архитектуру"]}'
        : systemPrompt.includes('аналитик требований')
          ? '{"done":true}'
          : content()[stageOf(systemPrompt)]();
      return new Conversation(
        clientWith(t, async () => ({ content: reply, usage: undefined })),
        {
          systemPrompt,
          temperature: 0.5,
          contextTokens: 8192,
          requestTimeoutMs: 5000,
        },
      );
    };
    const controller = new RunController({
      store: fakeStore(),
      makeConversation: make,
      output: out.stream,
      ask: answers(['да']),
      taskBridge: fakeBridge().bridge,
      invariants: () => ['всё на нативном TS'],
    });
    await controller.start('Задача');
    const text = out.text();
    assert.match(text, /контролёр: нарушены инварианты — перегенерация/); // не-фатальное замечание
    assert.match(text, /Инварианты нарушены и не исправлены/); // фатально → пауза
  });

  it('инварианты подаются в контекст аналитика и планировщика', async t => {
    const out = makeCollector();
    let clarifierPrompt = '';
    let planPrompt = '';
    const make: ConversationFactory = systemPrompt => {
      const isClarifier = systemPrompt.includes('аналитик требований');
      const isPlanner = systemPrompt.includes('планировщик');
      const client = clientWith(t, async messages => {
        const last = messages.at(-1)?.content ?? '';
        if (isClarifier) {
          clarifierPrompt = last;
          return { content: '{"done":true}', usage: undefined };
        }
        if (systemPrompt.includes('контролёр')) return { content: '{"ok":true}', usage: undefined };
        if (isPlanner) planPrompt = last;
        return { content: content()[stageOf(systemPrompt)](), usage: undefined };
      });
      return new Conversation(client, {
        systemPrompt,
        temperature: 0.5,
        contextTokens: 8192,
        requestTimeoutMs: 5000,
      });
    };
    const controller = new RunController({
      store: fakeStore(),
      makeConversation: make,
      output: out.stream,
      ask: answers(['да']),
      taskBridge: fakeBridge().bridge,
      invariants: () => ['React запрещён'],
    });
    await controller.start('Задача');
    assert.match(clarifierPrompt, /ИНВАРИАНТЫ[\s\S]*React запрещён/); // аналитик видит инварианты
    assert.match(planPrompt, /ИНВАРИАНТЫ[\s\S]*React запрещён/); // планировщик видит инварианты
  });

  it('edit сбрасывает счётчик проверок реализации', async t => {
    const run = createRun('Задача', { maxRetries: 2, idSuffix: 'er' });
    const out = makeCollector();
    const store = fakeStore([run]);
    const controller = new RunController({
      store,
      makeConversation: factory(t, content()), // проверка проходит
      output: out.stream,
      // Трижды отказ на завершении (maxRetries=2): retries 1, 2, затем пауза с retries=2.
      ask: answers(['нет', 'нет', 'нет']),
      taskBridge: fakeBridge().bridge,
    });
    await controller.continue(run.id);
    assert.equal(run.retries, 2); // на паузе счётчик накоплен отказами
    controller.edit('доработай валидацию');
    assert.match(out.text(), /Правка учтена/);
    assert.equal(run.retries, 0); // правка сбросила счётчик
    assert.equal(store.saved.at(-1)?.retries, 0); // и это сохранено
  });

  it('завершение прогона без задачи в памяти — без записи итога', async t => {
    const orphan = createRun('Осиротевшая', { idSuffix: 'o' }); // без taskId
    const out = makeCollector();
    const { bridge, adopted } = fakeBridge({ task: null });
    const controller = new RunController({
      store: fakeStore([orphan]),
      makeConversation: factory(t, content()),
      output: out.stream,
      ask: answers(['да']),
      taskBridge: bridge,
    });
    await controller.continue(orphan.id);
    const text = out.text();
    assert.deepEqual(adopted, []); // нет taskId — adopt не вызывался
    assert.match(text, /завершена и подтверждена\.\n/); // без «Итог записан»
    assert.doesNotMatch(text, /Итог записан/);
  });

  it('Ctrl+C (requestPause) ставит на паузу на границе этапа', async t => {
    const out = makeCollector();
    let controller: RunController;
    controller = new RunController({
      store: fakeStore(),
      makeConversation: factory(t, content(), {
        onStage: stage => {
          if (stage === 'planning') controller.requestPause();
        },
      }),
      output: out.stream,
      ask: answers(['да']),
      taskBridge: fakeBridge().bridge,
    });
    assert.equal(controller.isRunning(), false);
    await controller.start('Задача');
    assert.match(out.text(), /Пауза на этапе «выполнение»/);
    assert.equal(controller.isRunning(), false);
  });

  it('requestPause вне прогона — безопасный no-op', t => {
    const controller = new RunController({
      store: null,
      makeConversation: factory(t, content()),
      output: makeCollector().stream,
      ask: answers([]),
      taskBridge: fakeBridge().bridge,
    });
    controller.requestPause();
    assert.equal(controller.isRunning(), false);
  });

  it('ошибка модели на этапе печатается, прогон не падает', async t => {
    const out = makeCollector();
    const controller = new RunController({
      store: fakeStore(),
      makeConversation: factory(t, {
        ...content(),
        planning: () => {
          throw new Error('сбой провайдера');
        },
      }),
      output: out.stream,
      ask: answers([]),
      taskBridge: fakeBridge().bridge,
    });
    await controller.start('Задача');
    assert.match(out.text(), /\[ошибка\] сбой провайдера/);
  });

  it('continue без активного прогона подсказывает запуск', async t => {
    const out = makeCollector();
    const controller = new RunController({
      store: fakeStore(),
      makeConversation: factory(t, content()),
      output: out.stream,
      ask: answers([]),
      taskBridge: fakeBridge().bridge,
    });
    await controller.continue('');
    assert.match(out.text(), /Нет активного прогона/);
  });

  it('continue с неизвестным id сообщает, что прогон не найден', async t => {
    const out = makeCollector();
    const controller = new RunController({
      store: fakeStore(),
      makeConversation: factory(t, content()),
      output: out.stream,
      ask: answers([]),
      taskBridge: fakeBridge().bridge,
    });
    await controller.continue('нет-такого');
    assert.match(out.text(), /Прогон не найден: нет-такого/);
  });

  it('continue завершённого/отменённого прогона не запускает пайплайн', async t => {
    const done = { ...createRun('A', { idSuffix: 'd' }), status: 'completed' as const };
    const cancelled = { ...createRun('B', { idSuffix: 'c' }), status: 'cancelled' as const };
    const out = makeCollector();
    const controller = new RunController({
      store: fakeStore([done, cancelled]),
      makeConversation: factory(t, content()),
      output: out.stream,
      ask: answers([]),
      taskBridge: fakeBridge().bridge,
    });
    await controller.continue(done.id);
    await controller.continue(cancelled.id);
    const text = out.text();
    assert.match(text, /Прогон уже завершён/);
    assert.match(text, /Прогон отменён, продолжение невозможно/);
  });

  it('status: нет активного → подсказка; по id — подробности', async t => {
    const run = createRun('Задача', { idSuffix: 's' });
    run.artifacts.planning = { steps: ['ш'], criteria: ['к'], text: 'п' };
    const out = makeCollector();
    const controller = new RunController({
      store: fakeStore([run]),
      makeConversation: factory(t, content()),
      output: out.stream,
      ask: answers([]),
      taskBridge: fakeBridge().bridge,
    });
    controller.status();
    controller.status(run.id);
    controller.status('нет-такого');
    const text = out.text();
    assert.match(text, /Нет активного прогона/);
    assert.match(text, /Задача: Задача/);
    assert.match(text, /Планирование: 1 шаг/);
    assert.match(text, /Прогон не найден: нет-такого/);
  });

  it('list: пусто, есть прогоны и --ephemeral', async t => {
    const out1 = makeCollector();
    new RunController({
      store: fakeStore(),
      makeConversation: factory(t, content()),
      output: out1.stream,
      ask: answers([]),
      taskBridge: fakeBridge().bridge,
    }).list();
    assert.match(out1.text(), /Прогонов задач пока нет/);

    const run = createRun('Задача', { idSuffix: 'l' });
    const out2 = makeCollector();
    new RunController({
      store: fakeStore([run]),
      makeConversation: factory(t, content()),
      output: out2.stream,
      ask: answers([]),
      taskBridge: fakeBridge().bridge,
    }).list();
    assert.match(out2.text(), /Прогоны задач:/);

    const out3 = makeCollector();
    new RunController({
      store: null,
      makeConversation: factory(t, content()),
      output: out3.stream,
      ask: answers([]),
      taskBridge: fakeBridge().bridge,
    }).list();
    assert.match(out3.text(), /Хранилище прогонов отключено/);
  });

  it('edit: нет активного / пустой текст / не на паузе / успешно', async t => {
    const out = makeCollector();
    const store = fakeStore();
    const controller = new RunController({
      store,
      makeConversation: factory(t, content()),
      output: out.stream,
      ask: answers([]),
      taskBridge: fakeBridge().bridge,
    });
    controller.edit('правка'); // активного нет

    const paused = createRun('Задача', { idSuffix: 'e' }); // без taskId → adopt-ветка false
    store.save(paused);
    await controller.continue(paused.id); // happy path → completed
    controller.edit('правка'); // не на паузе (completed)

    const toPause = createRun('Вторая', { maxRetries: 0, idSuffix: 'p' });
    store.save(toPause);
    const failing = new RunController({
      store,
      makeConversation: factory(t, content()),
      output: out.stream,
      ask: answers(['нет']), // отказ при maxRetries=0 → пауза на завершении
      taskBridge: fakeBridge().bridge,
    });
    await failing.continue(toPause.id); // → paused
    failing.edit(''); // пустой текст
    failing.edit('добавь обработку ошибок'); // успешно

    const text = out.text();
    assert.match(text, /Нет активного прогона/);
    assert.match(text, /Правку можно внести только на паузе/);
    assert.match(text, /Укажите текст правки/);
    assert.match(text, /Правка учтена, применится при продолжении: добавь обработку ошибок/);
  });

  it('abort: нет активного / досрочное завершение', async t => {
    const out = makeCollector();
    const store = fakeStore();
    const controller = new RunController({
      store,
      makeConversation: factory(t, content()),
      output: out.stream,
      ask: answers([]),
      taskBridge: fakeBridge().bridge,
    });
    controller.abort(); // активного нет

    const run = createRun('Задача', { maxRetries: 0, idSuffix: 'a' });
    store.save(run);
    const failing = new RunController({
      store,
      makeConversation: factory(t, content()),
      output: out.stream,
      ask: answers(['нет']), // отказ при maxRetries=0 → пауза на завершении
      taskBridge: fakeBridge().bridge,
    });
    await failing.continue(run.id); // → paused, активный
    failing.abort();

    const text = out.text();
    assert.match(text, /Нет активного прогона/);
    assert.match(text, /завершена досрочно/);
    assert.ok(store.list().some(summary => summary.status === 'cancelled'));
  });
});

describe('RunController: рабочая копия проекта (День 34)', () => {
  const FILE_PROJECT: ProjectContext = {
    root: '/proj',
    name: 'proj',
    docSources: [],
    commands: { test: 'npm test' },
  };

  /** Мини-IO копии: makeTempDir → /tmp/run; ops для create/changeSummary/apply/dispose. */
  class MemIo implements WorkspaceIo {
    files = new Map<string, string>();
    symlinks: [string, string][] = [];
    removed: string[] = [];
    readFile = (path: string): string => this.files.get(path) ?? '';
    writeFile = (path: string, content: string): void => void this.files.set(path, content);
    exists = (path: string): boolean =>
      this.files.has(path) || [...this.files.keys()].some(key => key.startsWith(`${path}/`));
    isDirectory = (path: string): boolean =>
      !this.files.has(path) && [...this.files.keys()].some(key => key.startsWith(`${path}/`));
    listDir = (): string[] => [];
    deleteFile = (path: string): void => void this.files.delete(path);
    removeSymlink = (path: string): void => void this.files.delete(path);
    copyFile = (source: string, destination: string): void =>
      void this.files.set(destination, this.files.get(source) ?? '');
    symlink = (target: string, linkPath: string): void => void this.symlinks.push([target, linkPath]);
    makeTempDir = (): string => '/tmp/run';
    removeDir = (path: string): void => void this.removed.push(path);
  }

  /** Фейковый запуск команд копии: git-подкоманды и команды проекта; фиксирует вызовы. */
  function wsRunner(
    nameStatus: string,
    calls: string[] = [],
    failAdd = false,
  ): ProjectCommandRunner {
    return {
      run: async command => {
        calls.push(command);
        const failed = failAdd && command.includes('worktree add');
        let stdout = '';
        if (command.includes('--name-status')) {
          stdout = nameStatus;
        } else if (command.includes('diff --cached')) {
          stdout = 'DIFF-ТЕКСТ';
        }
        return { command, code: failed ? 1 : 0, stdout, stderr: failed ? 'boom' : '', timedOut: false };
      },
    };
  }

  it('прогон с проектом: правки копии применяются к проекту после подтверждения', async t => {
    const out = makeCollector();
    const io = new MemIo();
    io.files.set('/tmp/run/worktree/README.md', 'новое содержимое'); // «правка» агента в копии
    const calls: string[] = [];
    const { bridge, completed } = fakeBridge();
    const controller = new RunController({
      store: fakeStore(),
      makeConversation: factory(t, content()),
      output: out.stream,
      ask: answers(['да']),
      taskBridge: bridge,
      projects: () => [FILE_PROJECT],
      commandRunner: wsRunner('M\tREADME.md\n', calls),
      workspaceIo: io,
    });
    await controller.start('Обнови доки');

    const text = out.text();
    assert.match(text, /Рабочая копия проекта «proj» создана/);
    assert.match(text, /Изменения применены к проекту: README\.md/);
    assert.equal(io.files.get('/proj/README.md'), 'новое содержимое'); // применено копированием
    assert.ok(calls.some(command => command.includes('npm test'))); // команда проекта прогнана
    assert.ok(calls.some(command => command.includes('worktree remove'))); // копия удалена
    assert.deepEqual(completed, ['итог']);

    controller.abort(); // после завершения копии нет — ветка «нечего удалять» + строка abort
    assert.match(out.text(), /завершена досрочно/);
  });

  it('прогон с проектом без правок: сообщает об отсутствии изменений', async t => {
    const out = makeCollector();
    const controller = new RunController({
      store: fakeStore(),
      makeConversation: factory(t, content()),
      output: out.stream,
      ask: answers(['да']),
      taskBridge: fakeBridge().bridge,
      projects: () => [FILE_PROJECT],
      commandRunner: wsRunner('', []), // name-status пуст → изменений нет
      workspaceIo: new MemIo(),
    });
    await controller.start('Ничего не менять');
    assert.match(out.text(), /Файловых изменений не было/);
  });

  it('сбой создания рабочей копии → предупреждение, прогон идёт без файлов', async t => {
    const out = makeCollector();
    const { completed } = fakeBridge();
    const bridge = fakeBridge();
    const controller = new RunController({
      store: fakeStore(),
      makeConversation: factory(t, content()),
      output: out.stream,
      ask: answers(['да']),
      taskBridge: bridge.bridge,
      projects: () => [FILE_PROJECT],
      commandRunner: wsRunner('', [], true), // worktree add падает
      workspaceIo: new MemIo(),
    });
    await controller.start('Задача');
    assert.match(out.text(), /рабочая копия не создана/);
    assert.deepEqual(bridge.completed, ['итог']); // прогон всё равно завершился (текстовый)
    void completed;
  });

  it('нет запуска команд или IO — рабочая копия не создаётся', async t => {
    const noRunner = new RunController({
      store: fakeStore(),
      makeConversation: factory(t, content()),
      output: makeCollector().stream,
      ask: answers(['да']),
      taskBridge: fakeBridge().bridge,
      projects: () => [FILE_PROJECT], // проект есть, но нет commandRunner
      workspaceIo: new MemIo(),
    });
    const outNoIo = makeCollector();
    const noIo = new RunController({
      store: fakeStore(),
      makeConversation: factory(t, content()),
      output: outNoIo.stream,
      ask: answers(['да']),
      taskBridge: fakeBridge().bridge,
      projects: () => [FILE_PROJECT],
      commandRunner: wsRunner('', []), // есть runner, но нет workspaceIo
    });
    await noRunner.start('Задача');
    await noIo.start('Задача');
    assert.doesNotMatch(outNoIo.text(), /Рабочая копия/); // ни там, ни там копия не создаётся
  });

  /** Раннер, отдающий заданный список worktree на `worktree list`; фиксирует команды. */
  function worktreeRunner(list: string, calls: string[], throwing = false): ProjectCommandRunner {
    return {
      run: async command => {
        if (throwing) {
          throw new Error('git упал');
        }
        calls.push(command);
        return {
          command,
          code: 0,
          stdout: command.includes('worktree list') ? list : '',
          stderr: '',
          timedOut: false,
        };
      },
    };
  }

  it('cleanupOrphanWorktrees: снимает осиротевшие копии и сообщает', async t => {
    const out = makeCollector();
    const calls: string[] = [];
    const controller = new RunController({
      store: fakeStore(),
      makeConversation: factory(t, content()),
      output: out.stream,
      ask: answers([]),
      taskBridge: fakeBridge().bridge,
      projects: () => [FILE_PROJECT],
      commandRunner: worktreeRunner('worktree /proj\nworktree /tmp/llm-run-Z/worktree\n', calls),
      workspaceIo: new MemIo(),
    });
    await controller.cleanupOrphanWorktrees();
    assert.ok(calls.some(c => c.includes('worktree remove --force') && c.includes('llm-run-Z')));
    assert.match(out.text(), /Убрано осиротевших/);
  });

  it('cleanupOrphanWorktrees: нет осиротевших → без сообщения', async t => {
    const out = makeCollector();
    const controller = new RunController({
      store: fakeStore(),
      makeConversation: factory(t, content()),
      output: out.stream,
      ask: answers([]),
      taskBridge: fakeBridge().bridge,
      projects: () => [FILE_PROJECT],
      commandRunner: worktreeRunner('worktree /proj\n', []),
      workspaceIo: new MemIo(),
    });
    await controller.cleanupOrphanWorktrees();
    assert.doesNotMatch(out.text(), /Убрано осиротевших/);
  });

  it('cleanupOrphanWorktrees: нет швов/проектов и сбой — не роняет старт', async t => {
    const base = {
      store: fakeStore(),
      makeConversation: factory(t, content()),
      output: makeCollector().stream,
      ask: answers([]),
      taskBridge: fakeBridge().bridge,
    };
    await new RunController(base).cleanupOrphanWorktrees(); // нет commandRunner/workspaceIo → выход
    // швы есть, но проектов нет → пустой цикл
    await new RunController({
      ...base,
      commandRunner: worktreeRunner('', []),
      workspaceIo: new MemIo(),
    }).cleanupOrphanWorktrees();
    // сбой git → перехвачен (best-effort)
    await new RunController({
      ...base,
      projects: () => [FILE_PROJECT],
      commandRunner: worktreeRunner('', [], true),
      workspaceIo: new MemIo(),
    }).cleanupOrphanWorktrees();
  });

  it('пауза и продолжение переиспользуют одну рабочую копию', async t => {
    const out = makeCollector();
    const store = fakeStore();
    const calls: string[] = [];
    const run = createRun('Правки', { maxRetries: 0, idSuffix: 'ws-reuse' });
    store.save(run);
    const controller = new RunController({
      store,
      makeConversation: factory(t, content()),
      output: out.stream,
      ask: answers(['нет', 'да']), // 1-й проход: отказ → пауза; 2-й: подтверждение
      taskBridge: fakeBridge().bridge,
      projects: () => [FILE_PROJECT],
      commandRunner: wsRunner('', calls),
      workspaceIo: new MemIo(),
    });
    await controller.continue(run.id); // создаёт копию, пауза на отказе
    await controller.continue(run.id); // переиспользует ту же копию, завершает
    // Считаем именно команду создания (add --detach): «add -A» в git add попадает под наивный фильтр.
    const adds = calls.filter(command => command.includes('worktree add --detach')).length;
    assert.equal(adds, 1); // копия создана единожды — переиспользована, не пересоздана
  });
});
