import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { groundDocs, readChangedFiles, fileFromPatch } from '../index.ts';
import type { GroundingDeps } from '../index.ts';
import type { Document } from '../../../rag/src/index.ts';

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

describe('readChangedFiles', () => {
  it('читает изменённые, пропускает удалённые/бинарные/нечитаемые', () => {
    const files = [
      fileFromPatch('src/a.ts', '@@ -1 +1 @@\n+x', 'modified'),
      fileFromPatch('gone.ts', '', 'removed'),
      fileFromPatch('img.png', '', 'binary'),
      fileFromPatch('src/missing.ts', '@@ -1 +1 @@\n+y', 'modified'),
    ];
    const read = (path: string) => (path === 'src/a.ts' ? 'содержимое a' : null);
    assert.deepEqual(readChangedFiles(files, read), [
      { path: 'src/a.ts', content: 'содержимое a' },
    ]);
  });
});
