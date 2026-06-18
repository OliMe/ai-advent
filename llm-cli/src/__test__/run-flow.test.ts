import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Conversation, createRun } from '../../../core/src/index.ts';
import type { RunStore, RunSummary, Stage, TaskRun } from '../../../core/src/index.ts';
import { RunController, makeConversationFactory, type ConversationFactory } from '../run-flow.ts';
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

/** Фабрика диалогов: ответ зависит от персоны системного промпта; hook ловит этап. */
function factory(
  t: TestContext,
  by: StageContent,
  hook?: (stage: Stage) => void,
): ConversationFactory {
  return (systemPrompt, limits) => {
    const stage = stageOf(systemPrompt);
    const client = clientWith(t, async () => {
      hook?.(stage);
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
  it('start без описания подсказывает синтаксис', async t => {
    const out = makeCollector();
    const controller = new RunController({
      store: null,
      makeConversation: factory(t, content()),
      output: out.stream,
      ask: answers([]),
    });
    await controller.start('');
    assert.match(out.text(), /Укажите описание задачи/);
  });

  it('happy path: проходит этапы и завершается по подтверждению', async t => {
    const out = makeCollector();
    const store = fakeStore();
    const controller = new RunController({
      store,
      makeConversation: factory(t, content()),
      output: out.stream,
      ask: answers(['да']),
    });
    await controller.start('Задача');
    const text = out.text();
    assert.match(text, /Запущена задача «Задача»/);
    assert.match(text, /планирование…/);
    assert.match(text, /выполнено: готово/);
    assert.match(text, /проверка пройдена/);
    assert.match(text, /✓ Задача «Задача» завершена и подтверждена/);
    assert.ok(store.saved.some(run => run.status === 'completed'));
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
    });
    await controller.start('Задача');
    assert.match(out.text(), /попытка 1/);
  });

  it('провал проверки исчерпал ретраи → пауза с пояснением', async t => {
    const run = createRun('Задача', { maxRetries: 0, idSuffix: 'x' });
    const out = makeCollector();
    const controller = new RunController({
      store: fakeStore([run]),
      makeConversation: factory(t, content({ verification: () => FAIL })),
      output: out.stream,
      ask: answers([]),
    });
    await controller.continue(run.id);
    const text = out.text();
    assert.match(text, /Продолжаем «Задача» с этапа «планирование»/);
    assert.match(text, /Лимит авто-возвратов \(0\) исчерпан/);
  });

  it('Ctrl+C (requestPause) ставит на паузу на границе этапа', async t => {
    const out = makeCollector();
    let controller: RunController;
    controller = new RunController({
      store: fakeStore(),
      makeConversation: factory(t, content(), stage => {
        if (stage === 'planning') controller.requestPause();
      }),
      output: out.stream,
      ask: answers(['да']),
    });
    assert.equal(controller.isRunning(), false);
    await controller.start('Задача');
    const text = out.text();
    assert.match(text, /Пауза на этапе «выполнение»/);
    assert.equal(controller.isRunning(), false); // снят флаг после остановки
  });

  it('requestPause вне прогона — безопасный no-op', t => {
    const controller = new RunController({
      store: null,
      makeConversation: factory(t, content()),
      output: makeCollector().stream,
      ask: answers([]),
    });
    controller.requestPause(); // pause === null, ничего не происходит
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
    });
    controller.status(); // активного нет
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
    }).list();
    assert.match(out1.text(), /Прогонов задач пока нет/);

    const run = createRun('Задача', { idSuffix: 'l' });
    const out2 = makeCollector();
    new RunController({
      store: fakeStore([run]),
      makeConversation: factory(t, content()),
      output: out2.stream,
      ask: answers([]),
    }).list();
    assert.match(out2.text(), /Прогоны задач:/);
    assert.match(out2.text(), /Задача/);

    const out3 = makeCollector();
    new RunController({
      store: null,
      makeConversation: factory(t, content()),
      output: out3.stream,
      ask: answers([]),
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
    });
    controller.edit('правка'); // активного нет

    const paused = createRun('Задача', { idSuffix: 'e' });
    store.save(paused);
    await controller.continue(paused.id); // happy path → completed (active = paused, status completed)
    controller.edit('правка'); // не на паузе (completed)

    const toPause = createRun('Вторая', { maxRetries: 0, idSuffix: 'p' });
    store.save(toPause);
    const failing = new RunController({
      store,
      makeConversation: factory(t, content({ verification: () => FAIL })),
      output: out.stream,
      ask: answers([]),
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
    });
    controller.abort(); // активного нет

    const run = createRun('Задача', { maxRetries: 0, idSuffix: 'a' });
    store.save(run);
    const failing = new RunController({
      store,
      makeConversation: factory(t, content({ verification: () => FAIL })),
      output: out.stream,
      ask: answers([]),
    });
    await failing.continue(run.id); // → paused, становится активным
    failing.abort();

    const text = out.text();
    assert.match(text, /Нет активного прогона/);
    assert.match(text, /завершена досрочно/);
    assert.ok(store.list().some(summary => summary.status === 'cancelled'));
  });
});
