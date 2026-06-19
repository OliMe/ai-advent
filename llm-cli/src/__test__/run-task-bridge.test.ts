import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTask } from '../../../core/src/index.ts';
import type { Session, Task } from '../../../core/src/index.ts';
import { MemoryRunBridge, type TaskMemoryFacade } from '../run-task-bridge.ts';

/** Фасад памяти-заглушка с журналами вызовов и индексом задач по id. */
function facadeWith(seed: { current?: Task | null; existing?: Task[]; profile?: string[] } = {}) {
  const byId = new Map<string, Task>((seed.existing ?? []).map(task => [task.id, task]));
  let current: Task | null = seed.current ?? null;
  const calls = {
    addDetail: [] as Array<[string, string]>,
    markDone: [] as string[],
    adopt: [] as Array<string | undefined>,
  };
  const facade: TaskMemoryFacade = {
    currentTask: () => current,
    switchTask: arg => {
      const task = byId.get(arg) ?? [...byId.values()].find(t => t.title === arg) ?? null;
      if (task !== null) current = task;
      return task;
    },
    setTask: title => {
      const task = createTask(title);
      byId.set(task.id, task);
      current = task;
      return task;
    },
    adopt: id => {
      calls.adopt.push(id);
      current = id === undefined ? null : (byId.get(id) ?? null);
    },
    addTaskDetail: (id, detail) => {
      calls.addDetail.push([id, detail]);
      const task = byId.get(id) ?? null;
      if (task !== null) task.details.push(detail);
      return task;
    },
    markTaskDone: id => {
      calls.markDone.push(id);
      const task = byId.get(id) ?? null;
      if (task !== null && current?.id === id) current = null;
      return task;
    },
    profileEntries: () => seed.profile ?? [],
  };
  return { facade, calls };
}

function sessionWith(taskId?: string): Session {
  return {
    version: 1,
    id: 's1',
    model: 'm',
    createdAt: '',
    updatedAt: '',
    messages: [{ role: 'system', content: '' }],
    ...(taskId === undefined ? {} : { taskId }),
  };
}

describe('MemoryRunBridge', () => {
  it('current делегирует в фасад', () => {
    const task = createTask('Задача');
    const { facade } = facadeWith({ current: task });
    const bridge = new MemoryRunBridge({
      memory: facade,
      session: () => sessionWith(),
      saveSession: () => {},
    });
    assert.equal(bridge.current()?.id, task.id);
  });

  it('resolveOrCreate: существующая по id → активна, сессия привязана', () => {
    const existing = createTask('Старая');
    const { facade } = facadeWith({ existing: [existing] });
    const saved: Session[] = [];
    const session = sessionWith();
    const bridge = new MemoryRunBridge({
      memory: facade,
      session: () => session,
      saveSession: s => saved.push(s),
    });
    const task = bridge.resolveOrCreate(existing.id);
    assert.equal(task.id, existing.id);
    assert.equal(session.taskId, existing.id);
    assert.equal(saved.length, 1);
  });

  it('resolveOrCreate: новая по описанию (switchTask null → setTask)', () => {
    const { facade } = facadeWith();
    const session = sessionWith();
    const bridge = new MemoryRunBridge({
      memory: facade,
      session: () => session,
      saveSession: () => {},
    });
    const task = bridge.resolveOrCreate('новая задача');
    assert.equal(task.title, 'новая задача');
    assert.equal(session.taskId, task.id);
  });

  it('adopt делает задачу текущей и привязывает сессию', () => {
    const existing = createTask('Возобновляемая');
    const { facade, calls } = facadeWith({ existing: [existing] });
    const session = sessionWith();
    const saved: Session[] = [];
    const bridge = new MemoryRunBridge({
      memory: facade,
      session: () => session,
      saveSession: s => saved.push(s),
    });
    bridge.adopt(existing.id);
    assert.deepEqual(calls.adopt, [existing.id]);
    assert.equal(session.taskId, existing.id);
    assert.equal(saved.length, 1);
  });

  it('addDetail: пишет в текущую задачу; без текущей — no-op', () => {
    const task = createTask('Задача');
    const present = facadeWith({ current: task, existing: [task] });
    new MemoryRunBridge({
      memory: present.facade,
      session: () => sessionWith(),
      saveSession: () => {},
    }).addDetail('Требование: бюджет → 100к');
    assert.deepEqual(present.calls.addDetail, [[task.id, 'Требование: бюджет → 100к']]);

    const absent = facadeWith({ current: null });
    new MemoryRunBridge({
      memory: absent.facade,
      session: () => sessionWith(),
      saveSession: () => {},
    }).addDetail('игнор');
    assert.deepEqual(absent.calls.addDetail, []);
  });

  it('memoryContext: детали текущей задачи + профиль; пусто без задачи', () => {
    const task = createTask('Задача', ['бюджет 100к']);
    const withTask = facadeWith({ current: task, profile: ['любит кратко'] });
    const bridgeWith = new MemoryRunBridge({
      memory: withTask.facade,
      session: () => sessionWith(),
      saveSession: () => {},
    });
    const context = bridgeWith.memoryContext();
    assert.match(context, /Контекст задачи:\n- бюджет 100к/);
    assert.match(context, /О пользователе:\n- любит кратко/);

    const empty = facadeWith({ current: null, profile: [] });
    const bridgeEmpty = new MemoryRunBridge({
      memory: empty.facade,
      session: () => sessionWith(),
      saveSession: () => {},
    });
    assert.equal(bridgeEmpty.memoryContext(), '');
  });

  it('complete: пишет итог + done у текущей задачи, отвязывает сессию', () => {
    const task = createTask('Задача');
    const { facade, calls } = facadeWith({ current: task, existing: [task] });
    const session = sessionWith(task.id);
    const saved: Session[] = [];
    const bridge = new MemoryRunBridge({
      memory: facade,
      session: () => session,
      saveSession: s => saved.push(s),
    });
    assert.equal(bridge.complete('готово'), true);
    assert.deepEqual(calls.addDetail, [[task.id, 'Итог: готово']]);
    assert.deepEqual(calls.markDone, [task.id]);
    assert.equal(session.taskId, undefined); // отвязали выполненную
    assert.equal(saved.length, 1);
  });

  it('complete: пустой итог не пишет деталь; чужой taskId не трогает сессию', () => {
    const task = createTask('Задача');
    const { facade, calls } = facadeWith({ current: task, existing: [task] });
    const session = sessionWith('другая-задача');
    const saved: Session[] = [];
    const bridge = new MemoryRunBridge({
      memory: facade,
      session: () => session,
      saveSession: s => saved.push(s),
    });
    assert.equal(bridge.complete(''), true);
    assert.deepEqual(calls.addDetail, []); // пустой итог — без детали
    assert.deepEqual(calls.markDone, [task.id]);
    assert.equal(session.taskId, 'другая-задача'); // чужой указатель не тронут
    assert.equal(saved.length, 0);
  });

  it('complete без текущей задачи → false', () => {
    const { facade, calls } = facadeWith({ current: null });
    const bridge = new MemoryRunBridge({
      memory: facade,
      session: () => sessionWith(),
      saveSession: () => {},
    });
    assert.equal(bridge.complete('итог'), false);
    assert.deepEqual(calls.markDone, []);
  });
});
