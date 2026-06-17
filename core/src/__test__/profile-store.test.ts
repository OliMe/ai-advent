import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FileProfileStore,
  emptyProfile,
  summarizeProfile,
  PROFILE_VERSION,
  DEFAULT_PROFILE_NAME,
} from '../profile-store.ts';
import type { Profile } from '../profile-store.ts';

const FIXED = new Date('2026-06-10T14:25:30.000Z');

describe('emptyProfile / summarizeProfile', () => {
  it('создаёт пустой именованный профиль', () => {
    const profile = emptyProfile('работа', FIXED);
    assert.equal(profile.version, PROFILE_VERSION);
    assert.equal(profile.name, 'работа');
    assert.deepEqual(profile.entries, []);
    assert.equal(profile.updatedAt, '2026-06-10T14:25:30.000Z');
  });

  it('имя по умолчанию — default', () => {
    assert.equal(emptyProfile().name, DEFAULT_PROFILE_NAME);
  });

  it('сводка содержит имя и число пунктов', () => {
    const profile: Profile = {
      version: 1,
      name: 'p',
      entries: [
        { text: 'a', updatedAt: 't' },
        { text: 'b', updatedAt: 't' },
      ],
      updatedAt: 't',
    };
    assert.deepEqual(summarizeProfile(profile), { name: 'p', entryCount: 2, updatedAt: 't' });
  });
});

describe('FileProfileStore', () => {
  let rootDir: string;
  let profilesDir: string;
  let store: FileProfileStore;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'llm-profiles-'));
    profilesDir = join(rootDir, 'profiles');
    store = new FileProfileStore(profilesDir);
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('load на пустом месте возвращает пустой именованный профиль', () => {
    const profile = store.load('работа');
    assert.equal(profile.name, 'работа');
    assert.deepEqual(profile.entries, []);
  });

  it('сохраняет и загружает профиль (round-trip), создавая каталог', () => {
    const profile: Profile = {
      version: 1,
      name: 'личное',
      entries: [{ text: 'кратко', updatedAt: '2026-06-10T10:00:00.000Z' }],
      updatedAt: '2026-06-10T10:00:00.000Z',
    };
    store.save(profile);
    assert.deepEqual(store.load('личное'), profile);
  });

  it('имена с пробелами/кириллицей безопасны (кодируются в имя файла)', () => {
    const profile = {
      ...emptyProfile('моя персона', FIXED),
      entries: [{ text: 'x', updatedAt: 't' }],
    };
    store.save(profile);
    assert.deepEqual(store.load('моя персона').entries, [{ text: 'x', updatedAt: 't' }]);
  });

  it('list возвращает сводки, свежие первыми, пропуская не-json и .active', () => {
    store.save({ ...emptyProfile('a'), updatedAt: '2026-06-10T10:00:00.000Z' });
    store.save({ ...emptyProfile('b'), updatedAt: '2026-06-10T12:00:00.000Z' });
    store.setActive('b'); // создаёт .active — не должен попасть в список
    writeFileSync(join(profilesDir, 'readme.txt'), 'не json');

    assert.deepEqual(
      store.list().map(summary => summary.name),
      ['b', 'a'],
    );
  });

  it('list пуст, когда каталога ещё нет', () => {
    assert.deepEqual(store.list(), []);
  });

  it('activeName по умолчанию default; setActive сохраняет и читается', () => {
    assert.equal(store.activeName(), DEFAULT_PROFILE_NAME); // указателя нет
    store.setActive('работа');
    assert.equal(store.activeName(), 'работа');
    writeFileSync(join(profilesDir, '.active'), '   '); // пустой указатель → default
    assert.equal(store.activeName(), DEFAULT_PROFILE_NAME);
  });

  it('load терпим к битому JSON и к валидному не-профилю — пустой профиль', () => {
    mkdirSync(profilesDir, { recursive: true });
    writeFileSync(join(profilesDir, `${encodeURIComponent('p')}.json`), '{ битый');
    assert.deepEqual(store.load('p').entries, []);
    writeFileSync(join(profilesDir, `${encodeURIComponent('q')}.json`), '{"foo":1}');
    assert.deepEqual(store.load('q').entries, []); // валидно, но нет entries
  });

  it('migrateLegacy переносит старый profile.json в default и удаляет легаси', () => {
    const legacy = join(rootDir, 'profile.json');
    writeFileSync(
      legacy,
      JSON.stringify({ version: 1, entries: [{ text: 'старое', updatedAt: 't' }], updatedAt: 't' }),
    );

    store.migrateLegacy(legacy);

    const migrated = store.load(DEFAULT_PROFILE_NAME);
    assert.deepEqual(
      migrated.entries.map(e => e.text),
      ['старое'],
    );
    assert.throws(() => readFileSync(legacy, 'utf8')); // легаси удалён
  });

  it('migrateLegacy не трогает существующий default и не падает без легаси', () => {
    store.save({
      ...emptyProfile(DEFAULT_PROFILE_NAME),
      entries: [{ text: 'есть', updatedAt: 't' }],
    });
    const legacy = join(rootDir, 'profile.json');
    writeFileSync(legacy, JSON.stringify({ version: 1, entries: [], updatedAt: 't' }));

    store.migrateLegacy(legacy);
    assert.deepEqual(
      store.load(DEFAULT_PROFILE_NAME).entries.map(e => e.text),
      ['есть'], // не перезатёрт
    );
    assert.equal(readFileSync(legacy, 'utf8').length > 0, true); // легаси не удалён

    store.migrateLegacy(join(rootDir, 'нет.json')); // нет файла — молча
    writeFileSync(join(rootDir, 'битый.json'), '{ битый');
    store.migrateLegacy(join(rootDir, 'битый.json')); // битый — молча
  });

  it('migrateLegacy игнорирует валидный JSON, не похожий на профиль', () => {
    const legacy = join(rootDir, 'profile.json');
    writeFileSync(legacy, '{"foo":1}'); // валидно, но нет entries
    store.migrateLegacy(legacy);
    assert.deepEqual(store.list(), []); // профиль не создан
    assert.equal(readFileSync(legacy, 'utf8').length > 0, true); // легаси не удалён
  });

  it('migrateLegacy с битым JSON (default отсутствует) — молча', () => {
    const legacy = join(rootDir, 'profile.json');
    writeFileSync(legacy, '{ битый');
    store.migrateLegacy(legacy);
    assert.deepEqual(store.list(), []);
  });
});
