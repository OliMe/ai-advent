import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Conversation, createRun, createTask } from '../../../core/src/index.ts';
import type { RunStore, RunSummary, Stage, Task, TaskRun } from '../../../core/src/index.ts';
import {
  RunController,
  makeConversationFactory,
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
}

/** Фабрика диалогов: ответ зависит от персоны системного промпта; ловит этап/промпт. */
function factory(t: TestContext, by: StageContent, hooks: FactoryHooks = {}): ConversationFactory {
  return (systemPrompt, limits) => {
    const stage = stageOf(systemPrompt);
    const client = clientWith(t, async messages => {
      hooks.onStage?.(stage);
      hooks.onPrompt?.(stage, messages.at(-1)?.content ?? '');
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
  const bridge: RunTaskBridge = {
    current: () => task,
    resolveOrCreate: arg => {
      created.push(arg);
      return createTask(arg);
    },
    adopt: id => void adopted.push(id),
    memoryContext: () => opts.context ?? '',
    complete: summary => {
      completed.push(summary);
      return task !== null;
    },
  };
  return { bridge, completed, adopted, created };
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

describe('RunController', () => {
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
    // user-обрамление запуска + по ассистентскому сообщению на каждый из 4 этапов.
    assert.equal(recorded[0]?.role, 'user');
    assert.match(recorded[0].content, /Запуск задачи по этапам/);
    const stages = recorded.filter(entry => entry.role === 'assistant');
    assert.equal(stages.length, 4);
    assert.match(stages[0].content, /\[планирование\]/);
    assert.match(stages[3].content, /\[завершение\]/);
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

  it('провал проверки исчерпал ретраи → пауза (continue связывает задачу)', async t => {
    const run = createRun('Задача', { maxRetries: 0, idSuffix: 'x', taskId: 't1' });
    const out = makeCollector();
    const { bridge, adopted } = fakeBridge();
    const controller = new RunController({
      store: fakeStore([run]),
      makeConversation: factory(t, content({ verification: () => FAIL })),
      output: out.stream,
      ask: answers([]),
      taskBridge: bridge,
    });
    await controller.continue(run.id);
    const text = out.text();
    assert.deepEqual(adopted, ['t1']); // задача прогона стала текущей
    assert.match(text, /Продолжаем «Задача» с этапа «планирование»/);
    assert.match(text, /Лимит авто-возвратов \(0\) исчерпан/);
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
      makeConversation: factory(t, content({ verification: () => FAIL })),
      output: out.stream,
      ask: answers([]),
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
      makeConversation: factory(t, content({ verification: () => FAIL })),
      output: out.stream,
      ask: answers([]),
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
