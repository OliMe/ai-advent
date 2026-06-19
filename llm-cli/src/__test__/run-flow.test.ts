import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Conversation, createRun, createTask } from '../../../core/src/index.ts';
import type { RunStore, RunSummary, Stage, Task, TaskRun } from '../../../core/src/index.ts';
import {
  RunController,
  makeConversationFactory,
  parseClarifierStep,
  type ConversationFactory,
  type RunTaskBridge,
} from '../run-flow.ts';
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
  return (systemPrompt, limits) => {
    const isClarifier = systemPrompt.includes('аналитик');
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
    const askPrompts: string[] = [];
    const queue = ['бюджет 100к', '', 'да']; // 1-й вопрос; пустой (примет предложение); подтверждение
    let answerIndex = 0;
    const controller = new RunController({
      store: fakeStore(),
      makeConversation: factory(t, content(), { onClarifier: p => clarifierPrompts.push(p) }, [
        '{"question":"Какой бюджет?","suggestion":"100к"}',
        '{"question":"Какие сроки?","suggestion":"месяц"}',
        '{"done":true}',
      ]),
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
      const isClarifier = systemPrompt.includes('аналитик');
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
    // user-обрамление запуска + по ассистентскому сообщению на каждый из 5 этапов.
    assert.equal(recorded[0]?.role, 'user');
    assert.match(recorded[0].content, /Запуск задачи по этапам/);
    const stages = recorded.filter(entry => entry.role === 'assistant');
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
