import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { layerBudgets, MemoryManager, createMemoryStrategy } from '../index.ts';
import { clientWith } from './helpers.ts';
import { createTask, emptyProfile, summarizeProfile, summarizeTask } from '../index.ts';
import type {
  ChatMessage,
  CompletionResult,
  Profile,
  ProfileStore,
  Task,
  TaskStore,
  Usage,
} from '../index.ts';

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

  it('getTask/addTaskDetail/markTaskDone: доступ к задаче по id без смены активной', async t => {
    const mgr = makeManager(t, () => ({ content: '{}', usage: undefined }));
    const first = mgr.setTask('Первая');
    const second = mgr.setTask('Вторая'); // активная

    // getTask не меняет активную.
    assert.equal(mgr.getTask(first.id)?.id, first.id);
    assert.equal(mgr.getTask('нет'), null);
    assert.equal(mgr.currentTask()?.id, second.id);

    // addTaskDetail дописывает факт к указанной (не активной) задаче.
    assert.equal(mgr.addTaskDetail('нет', 'x'), null);
    const updated = mgr.addTaskDetail(first.id, 'итог работы');
    assert.deepEqual(updated?.details, ['итог работы']);
    assert.equal(mgr.currentTask()?.id, second.id); // активная не сменилась

    // markTaskDone по неактивной — не трогает активную.
    assert.equal(mgr.markTaskDone('нет'), null);
    assert.equal(mgr.markTaskDone(first.id)?.status, 'done');
    assert.equal(mgr.currentTask()?.id, second.id);

    // markTaskDone по активной — снимает её.
    assert.equal(mgr.markTaskDone(second.id)?.status, 'done');
    assert.equal(mgr.currentTask(), null);
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

  it('forgetProfile: удаляет несколько пунктов; сдвиг и невалидные не мешают', async t => {
    const mgr = makeManager(t, () => ({
      content: '{"task":[],"user":["a","b","c","d"]}',
      usage: undefined,
    }));
    await mgr.prepare([sys, { role: 'user', content: 'привет' }]);
    assert.deepEqual(mgr.profileEntries(), ['a', 'b', 'c', 'd']);
    // Удаляем 2 и 4 (b, d) разом — индексы резолвятся до удаления.
    assert.deepEqual(mgr.forgetProfile([2, 4, 9]), ['b', 'd']); // 9 вне диапазона — игнор
    assert.deepEqual(mgr.profileEntries(), ['a', 'c']);
    assert.deepEqual(mgr.forgetProfile([5]), []); // вне диапазона — пусто
    assert.deepEqual(mgr.forgetProfile([1]), ['a']); // одиночный — тоже массив
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
    const startProfile: Profile = {
      version: 1,
      name: 'default',
      entries: [{ text: 'старое', updatedAt: 't' }],
      updatedAt: 't',
    };
    const profileStore: ProfileStore = {
      list: () => [summarizeProfile(startProfile)],
      load: () => startProfile,
      save: p => profileSaved.push(p),
      delete: () => {},
      activeName: () => 'default',
      setActive: () => {},
    };
    const mgr = new MemoryManager({
      enabled: true,
      strategy,
      budgets,
      client,
      requestTimeoutMs: 5000,
      profile: startProfile,
      profileStore,
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
    assert.deepEqual(mgr.forgetProfile([1]), ['итог']); // забывание сохраняется в store

    assert.equal(mgr.deleteTask(created.id)?.id, created.id); // удаление идёт в store
    assert.equal(taskStore.load(created.id), null);
  });

  it('профили в памяти: switchProfile создаёт/переключает, listProfiles, currentProfileName', async t => {
    const mgr = makeManager(t, () => ({ content: '{}', usage: undefined })); // store=null → in-memory
    assert.equal(mgr.currentProfileName(), 'default');
    assert.equal(mgr.switchProfile('работа'), true); // новый → создан
    assert.equal(mgr.currentProfileName(), 'работа');
    assert.deepEqual(
      mgr
        .listProfiles()
        .map(p => p.name)
        .sort(),
      ['default', 'работа'],
    );
    assert.equal(mgr.switchProfile('default'), false); // существующий
    assert.equal(mgr.currentProfileName(), 'default');
  });

  it('профили в памяти: renameProfile и deleteProfile', async t => {
    const mgr = makeManager(t, () => ({ content: '{}', usage: undefined }));
    mgr.switchProfile('работа'); // активный работа; default тоже есть
    assert.equal(mgr.renameProfile('job'), 'ok');
    assert.equal(mgr.currentProfileName(), 'job');
    assert.ok(!mgr.listProfiles().some(p => p.name === 'работа')); // старое имя ушло
    assert.equal(mgr.renameProfile('job'), 'same'); // имя не изменилось
    assert.equal(mgr.renameProfile('default'), 'taken'); // занято

    assert.equal(mgr.deleteProfile('нет'), false); // нет такого
    assert.equal(mgr.deleteProfile('job'), true); // удаляем активный
    assert.equal(mgr.currentProfileName(), 'default'); // → переключение на default
    assert.ok(!mgr.listProfiles().some(p => p.name === 'job'));
  });

  it('профили с хранилищем: switch грузит/создаёт через store и пишет активный', async t => {
    const map = new Map<string, Profile>();
    let active = 'default';
    const profileStore: ProfileStore = {
      list: () => [...map.values()].map(summarizeProfile),
      load: name => map.get(name) ?? emptyProfile(name),
      save: p => {
        map.set(p.name, p);
      },
      delete: name => {
        map.delete(name);
      },
      activeName: () => active,
      setActive: name => {
        active = name;
      },
    };
    const client = clientWith(t, async () => ({ content: '{}', usage: undefined }));
    const mgr = new MemoryManager({
      enabled: true,
      strategy: createMemoryStrategy('window', budgets.short, 6, client, 5000),
      budgets,
      client,
      requestTimeoutMs: 5000,
      profile: emptyProfile('default'),
      profileStore,
      taskStore: null,
    });

    assert.equal(mgr.switchProfile('работа'), true); // создан через store
    assert.equal(active, 'работа'); // активный записан в указатель
    assert.ok(map.has('работа'));
    assert.ok(mgr.listProfiles().some(p => p.name === 'работа')); // список идёт через store
    assert.equal(mgr.switchProfile('работа'), false); // уже существует

    assert.equal(mgr.renameProfile('job'), 'ok'); // переименование через store
    assert.ok(map.has('job') && !map.has('работа'));
    assert.equal(active, 'job');
    assert.equal(mgr.deleteProfile('job'), true); // удаление активного через store
    assert.ok(!map.has('job'));
    assert.equal(mgr.currentProfileName(), 'default'); // → default
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
