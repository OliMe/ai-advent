import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_VERSION,
  sessionId,
  createSession,
  sessionPreview,
  summarize,
  type Session,
} from '../session.ts';
import type { ChatMessage } from '../types.ts';

const FIXED = new Date('2026-06-10T14:25:30.000Z');

describe('sessionId', () => {
  it('строит сортируемый id из UTC-времени и суффикса', () => {
    assert.equal(sessionId(FIXED, 'abc123'), '20260610T142530-abc123');
  });
});

describe('createSession', () => {
  it('создаёт сессию с id, метками времени и версией (явные now и суффикс)', () => {
    const messages: ChatMessage[] = [{ role: 'system', content: 'sys' }];
    const session = createSession('glm', messages, FIXED, 'aaa111');

    assert.equal(session.version, SESSION_VERSION);
    assert.equal(session.id, '20260610T142530-aaa111');
    assert.equal(session.model, 'glm');
    assert.equal(session.createdAt, '2026-06-10T14:25:30.000Z');
    assert.equal(session.updatedAt, session.createdAt);
    assert.equal(session.messages, messages);
  });

  it('по умолчанию подставляет текущее время и случайный суффикс', () => {
    const session = createSession('m', []);

    assert.match(session.id, /^\d{8}T\d{6}-[0-9a-f]{6}$/);
    assert.equal(session.messages.length, 0);
  });

  it('без имени ветки не добавляет поле label', () => {
    const session = createSession('m', [], FIXED, 'x');
    assert.ok(!('label' in session));
  });

  it('сохраняет имя ветки, если оно задано', () => {
    const session = createSession('m', [], FIXED, 'x', 'main');
    assert.equal(session.label, 'main');
  });
});

describe('sessionPreview', () => {
  const make = (messages: ChatMessage[]): Session => createSession('m', messages, FIXED, 'x');

  it('берёт первое пользовательское сообщение, схлопывая пробелы', () => {
    const session = make([
      { role: 'system', content: 'sys' },
      { role: 'user', content: '  привет\n  мир  ' },
    ]);
    assert.equal(sessionPreview(session), 'привет мир');
  });

  it('обрезает длинное превью с многоточием (явный maxLength)', () => {
    const session = make([{ role: 'user', content: 'a'.repeat(100) }]);
    const preview = sessionPreview(session, 10);

    assert.equal(preview.length, 10);
    assert.ok(preview.endsWith('…'));
  });

  it('возвращает пусто, если пользовательских сообщений нет', () => {
    const session = make([{ role: 'system', content: 'sys' }]);
    assert.equal(sessionPreview(session), '');
  });
});

describe('summarize', () => {
  it('собирает сводку с превью и числом сообщений', () => {
    const session = createSession(
      'glm',
      [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'вопрос' },
      ],
      FIXED,
      'sss',
    );
    const summary = summarize(session);

    assert.equal(summary.id, session.id);
    assert.equal(summary.model, 'glm');
    assert.equal(summary.preview, 'вопрос');
    assert.equal(summary.messageCount, 2);
    assert.equal(summary.createdAt, session.createdAt);
    assert.equal(summary.updatedAt, session.updatedAt);
    assert.ok(!('label' in summary)); // без label у сессии — нет и в сводке
  });

  it('переносит имя ветки в сводку', () => {
    const session = createSession('m', [{ role: 'user', content: 'q' }], FIXED, 'sss', 'alpha');
    assert.equal(summarize(session).label, 'alpha');
  });
});
