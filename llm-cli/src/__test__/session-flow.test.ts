import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSession } from '../index.ts';
import { fakeStore } from './helpers.ts';
import { makeConfig } from '../../../core/src/__test__/helpers.ts';
import type { Session } from '../../../core/src/index.ts';

describe('resolveSession', () => {
  const config = makeConfig({ model: 'glm', systemPrompt: 'СИС' });

  /** Существующая сессия (ветка) для подмены в хранилище. */
  function existing(id: string, label?: string): Session {
    return {
      version: 1,
      id,
      model: 'other',
      ...(label === undefined ? {} : { label }),
      createdAt: '2026-06-10T10:00:00.000Z',
      updatedAt: '2026-06-10T10:00:00.000Z',
      messages: [
        { role: 'system', content: 'СТАРАЯ СИСТЕМА' },
        { role: 'user', content: 'давний вопрос' },
      ],
    };
  }

  it('без switch/branch — новая ветка main с системой из конфига', () => {
    const session = resolveSession(fakeStore(), config, {}, undefined, undefined);
    assert.equal(session.messages.length, 1);
    assert.deepEqual(session.messages[0], { role: 'system', content: 'СИС' });
    assert.equal(session.label, 'main');
  });

  it('store=null (ephemeral) — всегда новая ветка', () => {
    const session = resolveSession(null, config, {}, 'last', undefined);
    assert.equal(session.messages[0].content, 'СИС');
  });

  it('switch=last без прошлых веток — новая', () => {
    const session = resolveSession(fakeStore(), config, {}, 'last', undefined);
    assert.equal(session.messages[0].content, 'СИС');
  });

  it('switch=last с существующей — продолжает её (система заморожена)', () => {
    const previous = existing('id-last');
    const session = resolveSession(fakeStore([previous]), config, {}, 'last', undefined);
    assert.equal(session.id, 'id-last');
    assert.equal(session.messages[0].content, 'СТАРАЯ СИСТЕМА'); // конфиг не влияет
  });

  it('switch по id, которого нет — бросает ошибку', () => {
    assert.throws(() => resolveSession(fakeStore(), config, {}, 'нет', undefined), /не найдена/);
  });

  it('switch по id — продолжает существующую', () => {
    const previous = existing('id-x');
    const session = resolveSession(fakeStore([previous]), config, {}, 'id-x', undefined);
    assert.equal(session.id, 'id-x');
  });

  it('switch по имени (label) — находит нужную ветку', () => {
    const previous = existing('id-y', 'alpha');
    const session = resolveSession(fakeStore([previous]), config, {}, 'alpha', undefined);
    assert.equal(session.id, 'id-y');
  });

  it('branch от switch-базы — копия сообщений с новым именем, оригинал цел', () => {
    const previous = existing('id-base', 'main');
    const session = resolveSession(fakeStore([previous]), config, {}, 'main', 'feature');

    assert.notEqual(session.id, 'id-base'); // другой id
    assert.equal(session.label, 'feature');
    assert.deepEqual(session.messages, previous.messages); // копия содержимого
    assert.notEqual(session.messages, previous.messages); // но не та же ссылка
  });

  it('branch без switch — ответвляется от последней ветки', () => {
    const previous = existing('id-latest', 'main');
    const session = resolveSession(fakeStore([previous]), config, {}, undefined, 'feature');
    assert.equal(session.label, 'feature');
    assert.deepEqual(session.messages, previous.messages);
  });

  it('branch с занятым именем — бросает ошибку', () => {
    const previous = existing('id-base', 'feature');
    assert.throws(
      () => resolveSession(fakeStore([previous]), config, {}, 'last', 'feature'),
      /уже существует/,
    );
  });

  it('branch без единой сессии — новая ветка с этим именем', () => {
    const session = resolveSession(fakeStore(), config, {}, undefined, 'feature');
    assert.equal(session.label, 'feature');
    assert.equal(session.messages[0].content, 'СИС'); // система из конфига
  });
});
