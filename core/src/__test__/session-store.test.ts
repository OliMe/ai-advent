import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSessionStore } from '../session-store.ts';
import type { Session } from '../session.ts';

/** Сессия с заданными id и временем обновления. */
function makeSession(id: string, updatedAt: string): Session {
  return {
    version: 1,
    id,
    model: 'm',
    createdAt: updatedAt,
    updatedAt,
    messages: [{ role: 'user', content: `q-${id}` }],
  };
}

describe('FileSessionStore', () => {
  let rootDir: string;
  let sessionsDir: string;
  let store: FileSessionStore;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'llm-sessions-'));
    // Подкаталога ещё нет — store должен создать его при первом save.
    sessionsDir = join(rootDir, 'sessions');
    store = new FileSessionStore(sessionsDir);
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('сохраняет и загружает сессию (round-trip), создавая каталог', () => {
    const session = makeSession('20260610T100000-a', '2026-06-10T10:00:00.000Z');
    store.save(session);

    assert.deepEqual(store.load(session.id), session);
  });

  it('load возвращает null для несуществующей сессии', () => {
    assert.equal(store.load('нет-такой'), null);
  });

  it('list и latest пусты, когда каталога ещё нет', () => {
    assert.deepEqual(store.list(), []);
    assert.equal(store.latest(), null);
  });

  it('save перезаписывает сессию с тем же id', () => {
    store.save(makeSession('id1', '2026-06-10T10:00:00.000Z'));
    store.save({ ...makeSession('id1', '2026-06-10T11:00:00.000Z'), model: 'glm' });

    assert.equal(store.load('id1')?.model, 'glm');
    assert.equal(store.list().length, 1);
  });

  it('list сортирует по updatedAt (свежие первыми) и пропускает не-json и битые файлы', () => {
    store.save(makeSession('20260610T100000-a', '2026-06-10T10:00:00.000Z'));
    store.save(makeSession('20260610T120000-b', '2026-06-10T12:00:00.000Z'));
    writeFileSync(join(sessionsDir, 'readme.txt'), 'не json');
    writeFileSync(join(sessionsDir, 'broken.json'), '{ битый');

    assert.deepEqual(
      store.list().map(summary => summary.id),
      ['20260610T120000-b', '20260610T100000-a'],
    );
  });

  it('latest возвращает самую свежеобновлённую сессию', () => {
    store.save(makeSession('a', '2026-06-10T10:00:00.000Z'));
    store.save(makeSession('b', '2026-06-10T12:00:00.000Z'));

    assert.equal(store.latest()?.id, 'b');
  });

  it('load терпим к не-сессиям в JSON (null, число, объект без полей)', () => {
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'n.json'), 'null');
    writeFileSync(join(sessionsDir, 'num.json'), '5');
    writeFileSync(join(sessionsDir, 'noid.json'), '{}');
    writeFileSync(join(sessionsDir, 'nomsgs.json'), '{"id":"x"}');

    assert.equal(store.load('n'), null);
    assert.equal(store.load('num'), null);
    assert.equal(store.load('noid'), null);
    assert.equal(store.load('nomsgs'), null);
  });
});
