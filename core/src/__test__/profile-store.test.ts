import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileProfileStore, emptyProfile, PROFILE_VERSION } from '../profile-store.ts';
import type { Profile } from '../profile-store.ts';

const FIXED = new Date('2026-06-10T14:25:30.000Z');

describe('emptyProfile', () => {
  it('создаёт пустой профиль с версией и временем', () => {
    const profile = emptyProfile(FIXED);
    assert.equal(profile.version, PROFILE_VERSION);
    assert.deepEqual(profile.entries, []);
    assert.equal(profile.updatedAt, '2026-06-10T14:25:30.000Z');
  });
});

describe('FileProfileStore', () => {
  let rootDir: string;
  let profilePath: string;
  let store: FileProfileStore;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'llm-profile-'));
    // Подкаталога ещё нет — store должен создать его при первом save.
    profilePath = join(rootDir, 'nested', 'profile.json');
    store = new FileProfileStore(profilePath);
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('load на пустом месте возвращает пустой профиль', () => {
    assert.deepEqual(store.load().entries, []);
  });

  it('сохраняет и загружает профиль (round-trip), создавая каталог', () => {
    const profile: Profile = {
      version: 1,
      entries: [{ text: 'предпочитает краткие ответы', updatedAt: '2026-06-10T10:00:00.000Z' }],
      updatedAt: '2026-06-10T10:00:00.000Z',
    };
    store.save(profile);
    assert.deepEqual(store.load(), profile);
  });

  it('save перезаписывает профиль целиком', () => {
    store.save({ ...emptyProfile(FIXED), entries: [{ text: 'a', updatedAt: 't' }] });
    store.save({ ...emptyProfile(FIXED), entries: [{ text: 'b', updatedAt: 't' }] });
    assert.deepEqual(
      store.load().entries.map(entry => entry.text),
      ['b'],
    );
  });

  it('load терпим к битому JSON и не-профилю — возвращает пустой', () => {
    writeFileSync(join(rootDir, 'flat.json'), '{ битый');
    assert.deepEqual(new FileProfileStore(join(rootDir, 'flat.json')).load().entries, []);

    writeFileSync(join(rootDir, 'noentries.json'), '{"version":1}');
    assert.deepEqual(new FileProfileStore(join(rootDir, 'noentries.json')).load().entries, []);

    writeFileSync(join(rootDir, 'nullp.json'), 'null');
    assert.deepEqual(new FileProfileStore(join(rootDir, 'nullp.json')).load().entries, []);
  });
});
