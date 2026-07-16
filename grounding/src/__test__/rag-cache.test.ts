import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { groundDocs, warmDocsIndex } from '../index.ts';
import type { GroundingDeps, IndexCache } from '../index.ts';
import type { Document, Index } from '../../../rag/src/index.ts';

const DOCS: Document[] = [
  { source: '/repo', file: 'README.md', title: 'README', text: 'Сервис считает доставку заказов.' },
  { source: '/repo', file: 'docs/auth.md', title: 'auth', text: 'Авторизация по bearer-токену.' },
];

/** Детерминированный «эмбеддинг»: вектор из длины текста и наличия ключевого слова. */
const keywordEmbed = (word: string) => async (inputs: string[]) =>
  inputs.map(text => [text.toLowerCase().includes(word) ? 1 : 0, text.length]);

describe('groundDocs', () => {
  it('через RAG возвращает top-k фрагментов по запросу', async () => {
    const deps: GroundingDeps = {
      embed: keywordEmbed('доставк'),
      loadDocs: () => DOCS,
      now: '2026-07-15T00:00:00.000Z',
      topKCount: 1,
    };
    const fragments = await groundDocs(deps, 'как считается доставка');
    assert.equal(fragments.length, 1);
    assert.match(fragments[0], /README\.md/);
    assert.match(fragments[0], /доставку заказов/);
  });

  it('нет доков — пустой список (индексировать нечего)', async () => {
    const deps: GroundingDeps = {
      embed: keywordEmbed('x'),
      loadDocs: () => [],
      now: 'now',
      topKCount: 3,
    };
    assert.deepEqual(await groundDocs(deps, 'вопрос'), []);
  });

  it('эмбеддинги упали — мягкая деградация: сырые доки напрямую', async () => {
    const deps: GroundingDeps = {
      embed: async () => {
        throw new Error('эндпоинт недоступен');
      },
      loadDocs: () => DOCS,
      now: 'now',
      topKCount: 3,
    };
    const fragments = await groundDocs(deps, 'вопрос');
    assert.equal(fragments.length, 2);
    assert.match(fragments[0], /README\.md/);
    assert.match(fragments[1], /docs\/auth\.md/);
  });

  it('эмбеддинг вернул пустой вектор запроса — тоже деградация', async () => {
    const deps: GroundingDeps = {
      // Индекс собирается (чанки доков эмбеддятся), но запрос «вопрос» → пустой ответ (нет вектора).
      embed: async (inputs: string[]) =>
        inputs.length === 1 && inputs[0] === 'вопрос' ? [] : inputs.map(text => [1, text.length]),
      loadDocs: () => DOCS,
      now: 'now',
      topKCount: 3,
    };
    const fragments = await groundDocs(deps, 'вопрос');
    assert.equal(fragments.length, 2); // ушли в фолбэк
  });
});

/** Кэш индекса в памяти (для проверки попадания/промаха без ФС). */
function memCache(): IndexCache & { store: Map<string, Index> } {
  const store = new Map<string, Index>();
  return {
    store,
    load: key => store.get(key) ?? null,
    save: (key, index) => void store.set(key, index),
  };
}

describe('groundDocs с кэшем индекса', () => {
  it('промах → собирает индекс и сохраняет под ключом', async () => {
    const cache = memCache();
    const deps: GroundingDeps = {
      embed: keywordEmbed('доставк'),
      loadDocs: () => DOCS,
      now: 't',
      topKCount: 1,
      cache,
      embeddingId: 'nomic',
    };
    const fragments = await groundDocs(deps, 'как считается доставка');
    assert.equal(fragments.length, 1);
    assert.equal(cache.store.size, 1); // индекс закэширован
  });

  it('попадание на втором прогоне → корпус не пересобирается (эмбеддится только запрос)', async () => {
    const cache = memCache();
    let embedCalls = 0;
    const deps: GroundingDeps = {
      embed: async (inputs: string[]) => {
        embedCalls += 1;
        return inputs.map(text => [text.toLowerCase().includes('доставк') ? 1 : 0, text.length]);
      },
      loadDocs: () => DOCS,
      now: 't',
      topKCount: 1,
      cache,
      embeddingId: 'nomic',
    };
    await groundDocs(deps, 'как считается доставка'); // промах: корпус + запрос
    const afterMiss = embedCalls;
    await groundDocs(deps, 'как считается доставка'); // попадание: только запрос
    assert.equal(embedCalls - afterMiss, 1);
    assert.equal(cache.store.size, 1);
  });

  it('кэш без embeddingId — ключ со схемой по умолчанию (пустая), всё равно кэширует', async () => {
    const cache = memCache();
    const deps: GroundingDeps = {
      embed: keywordEmbed('доставк'),
      loadDocs: () => DOCS,
      now: 't',
      topKCount: 1,
      cache,
    };
    const fragments = await groundDocs(deps, 'как считается доставка');
    assert.equal(fragments.length, 1);
    assert.equal(cache.store.size, 1);
  });
});

describe('warmDocsIndex (строгий прогрев)', () => {
  it('собирает индекс, сохраняет в кэш, возвращает число чанков', async () => {
    const cache = memCache();
    const chunkCount = await warmDocsIndex({
      embed: keywordEmbed('доставк'),
      loadDocs: () => DOCS,
      now: 't',
      topKCount: 1,
      cache,
      embeddingId: 'nomic',
    });
    assert.ok(chunkCount >= 1);
    assert.equal(cache.store.size, 1);
  });

  it('нет доков → 0 (кэшировать нечего)', async () => {
    const chunkCount = await warmDocsIndex({
      embed: keywordEmbed('x'),
      loadDocs: () => [],
      now: 't',
      topKCount: 1,
    });
    assert.equal(chunkCount, 0);
  });

  it('ошибка эмбеддера ПРОБРАСЫВАЕТСЯ (видимое падение, не мягкая деградация)', async () => {
    await assert.rejects(
      warmDocsIndex({
        embed: async () => {
          throw new Error('эндпоинт недоступен');
        },
        loadDocs: () => DOCS,
        now: 't',
        topKCount: 1,
      }),
      /эндпоинт недоступен/,
    );
  });
});
