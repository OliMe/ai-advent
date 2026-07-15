import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderComment, buildPublication, markComment, AI_REVIEW_MARKER } from '../index.ts';
import type { Finding } from '../index.ts';

const finding = (over: Partial<Finding> = {}): Finding => ({
  file: 'a.ts',
  line: 3,
  severity: 'bug',
  title: 'заголовок',
  body: 'пояснение',
  ...over,
});

describe('renderComment', () => {
  it('метка категории, заголовок и тело', () => {
    const text = renderComment(finding());
    assert.match(text, /🐞 Баг: заголовок/);
    assert.match(text, /пояснение/);
  });

  it('пустое тело — только заголовок', () => {
    assert.doesNotMatch(renderComment(finding({ body: '  ' })), /\n\n/);
  });
});

describe('buildPublication', () => {
  it('инлайн-находки → комментарии, общие → в сводку', () => {
    const pub = buildPublication('Кратко: пара замечаний.', {
      inline: [finding({ file: 'a.ts', line: 3 })],
      general: [finding({ file: 'b.ts', line: 9, severity: 'architecture', title: 'связность' })],
    });
    // Тело комментария несёт маркер идемпотентности (чтобы узнать свой при повторном прогоне).
    assert.deepEqual(pub.comments, [
      {
        file: 'a.ts',
        line: 3,
        body: markComment(renderComment(finding({ file: 'a.ts', line: 3 }))),
      },
    ]);
    assert.ok(pub.comments[0].body.includes(AI_REVIEW_MARKER));
    assert.match(pub.summary, /## 🤖 AI-ревью/);
    assert.match(pub.summary, /Кратко: пара замечаний/);
    assert.match(pub.summary, /без точной привязки/);
    assert.match(pub.summary, /`b\.ts:9`/);
  });

  it('нет замечаний и пустая сводка — доброжелательная строка', () => {
    const pub = buildPublication('', { inline: [], general: [] });
    assert.deepEqual(pub.comments, []);
    assert.match(pub.summary, /замечаний не найдено/);
  });

  it('есть инлайн, но сводка пустая — без «не найдено» и без секции общих', () => {
    const pub = buildPublication('', { inline: [finding()], general: [] });
    assert.equal(pub.comments.length, 1);
    assert.doesNotMatch(pub.summary, /не найдено/);
    assert.doesNotMatch(pub.summary, /без точной привязки/);
  });
});
