import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileTaskStore, createTask, summarizeTask, TASK_VERSION } from '../task-store.ts';
import type { Task } from '../task-store.ts';

const FIXED = new Date('2026-06-10T14:25:30.000Z');

/** Задача с заданными id и временем обновления. */
function makeTask(id: string, updatedAt: string): Task {
  return {
    version: 1,
    id,
    title: `задача ${id}`,
    status: 'active',
    details: [`деталь ${id}`],
    createdAt: updatedAt,
    updatedAt,
  };
}

describe('createTask / summarizeTask', () => {
  it('создаёт активную задачу с id, временем и версией', () => {
    const task = createTask('Сбор ТЗ', ['цель: приложение'], FIXED, 'aaa111');

    assert.equal(task.version, TASK_VERSION);
    assert.equal(task.id, '20260610T142530-aaa111');
    assert.equal(task.title, 'Сбор ТЗ');
    assert.equal(task.status, 'active');
    assert.deepEqual(task.details, ['цель: приложение']);
    assert.equal(task.createdAt, '2026-06-10T14:25:30.000Z');
    assert.equal(task.updatedAt, task.createdAt);
  });

  it('по умолчанию пустые детали и случайный суффикс id', () => {
    const task = createTask('X');
    assert.match(task.id, /^\d{8}T\d{6}-[0-9a-f]{6}$/);
    assert.deepEqual(task.details, []);
  });

  it('сводка содержит число деталей и статус', () => {
    const task = createTask('T', ['a', 'b'], FIXED, 'sss');
    const summary = summarizeTask(task);
    assert.equal(summary.id, task.id);
    assert.equal(summary.title, 'T');
    assert.equal(summary.status, 'active');
    assert.equal(summary.detailCount, 2);
    assert.equal(summary.createdAt, task.createdAt);
    assert.equal(summary.updatedAt, task.updatedAt);
  });
});

describe('FileTaskStore', () => {
  let rootDir: string;
  let tasksDir: string;
  let store: FileTaskStore;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'llm-tasks-'));
    tasksDir = join(rootDir, 'tasks');
    store = new FileTaskStore(tasksDir);
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('сохраняет и загружает задачу (round-trip), создавая каталог', () => {
    const task = makeTask('20260610T100000-a', '2026-06-10T10:00:00.000Z');
    store.save(task);
    assert.deepEqual(store.load(task.id), task);
  });

  it('load возвращает null для несуществующей задачи', () => {
    assert.equal(store.load('нет-такой'), null);
  });

  it('list пуст, когда каталога ещё нет', () => {
    assert.deepEqual(store.list(), []);
  });

  it('save перезаписывает задачу с тем же id', () => {
    store.save(makeTask('id1', '2026-06-10T10:00:00.000Z'));
    store.save({ ...makeTask('id1', '2026-06-10T11:00:00.000Z'), status: 'done' });

    assert.equal(store.load('id1')?.status, 'done');
    assert.equal(store.list().length, 1);
  });

  it('list сортирует по updatedAt (свежие первыми), пропуская не-json и битые', () => {
    store.save(makeTask('20260610T100000-a', '2026-06-10T10:00:00.000Z'));
    store.save(makeTask('20260610T120000-b', '2026-06-10T12:00:00.000Z'));
    writeFileSync(join(tasksDir, 'readme.txt'), 'не json');
    writeFileSync(join(tasksDir, 'broken.json'), '{ битый');

    assert.deepEqual(
      store.list().map(summary => summary.id),
      ['20260610T120000-b', '20260610T100000-a'],
    );
  });

  it('delete удаляет задачу; повторное удаление не падает', () => {
    const task = makeTask('20260610T100000-a', '2026-06-10T10:00:00.000Z');
    store.save(task);
    assert.notEqual(store.load(task.id), null);

    store.delete(task.id);
    assert.equal(store.load(task.id), null);
    assert.deepEqual(store.list(), []);
    store.delete(task.id); // нет файла — молча
    store.delete('никогда-не-существовал'); // тоже молча
  });

  it('load терпим к не-задачам в JSON (null, число, объект без полей)', () => {
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, 'n.json'), 'null');
    writeFileSync(join(tasksDir, 'num.json'), '5');
    writeFileSync(join(tasksDir, 'noid.json'), '{}');
    writeFileSync(join(tasksDir, 'notitle.json'), '{"id":"x"}');
    writeFileSync(join(tasksDir, 'nodetails.json'), '{"id":"x","title":"t"}');

    assert.equal(store.load('n'), null);
    assert.equal(store.load('num'), null);
    assert.equal(store.load('noid'), null);
    assert.equal(store.load('notitle'), null);
    assert.equal(store.load('nodetails'), null);
  });
});
