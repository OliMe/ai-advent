import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileRunStore, createRun } from '../index.ts';
import type { TaskRun } from '../index.ts';

describe('FileRunStore', () => {
  let rootDir: string;
  let runsDir: string;
  let store: FileRunStore;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'llm-runs-'));
    runsDir = join(rootDir, 'runs');
    store = new FileRunStore(runsDir);
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('сохраняет и загружает прогон (round-trip), создавая каталог', () => {
    const run = createRun('Задача', { now: new Date('2026-06-10T10:00:00.000Z'), idSuffix: 'a' });
    store.save(run);
    assert.deepEqual(store.load(run.id), run);
  });

  it('load возвращает null для несуществующего и битого', () => {
    assert.equal(store.load('нет'), null);
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(runsDir, 'broken.json'), '{ битый');
    assert.equal(store.load('broken'), null);
    writeFileSync(join(runsDir, 'noid.json'), '{}');
    assert.equal(store.load('noid'), null);
  });

  it('list сортирует по updatedAt (свежие первыми), пропуская не-json', () => {
    store.save({
      ...createRun('A', { idSuffix: 'a' }),
      id: 'a',
      updatedAt: '2026-06-10T10:00:00.000Z',
    });
    store.save({
      ...createRun('B', { idSuffix: 'b' }),
      id: 'b',
      updatedAt: '2026-06-10T12:00:00.000Z',
    });
    writeFileSync(join(runsDir, 'readme.txt'), 'не json');
    assert.deepEqual(
      store.list().map(summary => summary.id),
      ['b', 'a'],
    );
  });

  it('list пуст, когда каталога ещё нет', () => {
    assert.deepEqual(store.list(), []);
  });

  it('writeArtifact пишет файл-артефакт и возвращает путь', () => {
    const path = store.writeArtifact('run-1', 'execution-1.md', 'результат работы');
    assert.equal(readFileSync(path, 'utf8'), 'результат работы');
    assert.equal(path, join(runsDir, 'run-1', 'execution-1.md'));
  });

  it('delete удаляет прогон и каталог его файлов-артефактов', () => {
    const run: TaskRun = { ...createRun('X', { idSuffix: 'x' }), id: 'x' };
    store.save(run);
    store.writeArtifact('x', 'out.txt', 'данные');
    assert.notEqual(store.load('x'), null);

    store.delete('x');
    assert.equal(store.load('x'), null);
    assert.equal(existsSync(join(runsDir, 'x')), false); // каталог артефактов удалён
    store.delete('x'); // повторно — молча
  });
});
