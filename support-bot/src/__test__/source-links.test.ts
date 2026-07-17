import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  repoWebBaseFromTicketUrl,
  buildSourceLinkContext,
  githubHeadingAnchor,
  linkifySources,
} from '../index.ts';
import type { SearchChunk } from '../../../grounding/src/index.ts';

const CHUNKS: SearchChunk[] = [
  {
    chunk_id: 'authorization.md#1',
    source: '/repo/support-bot/faq',
    file: 'authorization.md',
    section: 'Почему не работает авторизация к LLM-эндпоинту?',
    score: 0.9,
    text: 'Проверьте заголовок Authorization.',
  },
  {
    chunk_id: 'authorization.md#2',
    source: '/repo/support-bot/faq',
    file: 'authorization.md',
    section: 'Что означает ответ 401, а что 403?',
    score: 0.8,
    text: '401 — токен не совпал.',
  },
];

describe('repoWebBaseFromTicketUrl', () => {
  it('вырезает базу репозитория до /issues/', () => {
    assert.equal(
      repoWebBaseFromTicketUrl('https://github.com/OliMe/ai-advent/issues/5'),
      'https://github.com/OliMe/ai-advent',
    );
  });

  it('нет /issues/ → null', () => {
    assert.equal(repoWebBaseFromTicketUrl('https://example/x'), null);
  });
});

describe('buildSourceLinkContext', () => {
  it('собирает blob-базу из url + ref', () => {
    const ctx = buildSourceLinkContext('https://github.com/o/r/issues/1', 'abc123', '/repo');
    assert.deepEqual(ctx, { blobBaseUrl: 'https://github.com/o/r/blob/abc123', repoRoot: '/repo' });
  });

  it('нераспознанный url → null', () => {
    assert.equal(buildSourceLinkContext('нет', 'main', '/repo'), null);
  });

  it('пустой ref или корень → null', () => {
    assert.equal(buildSourceLinkContext('https://github.com/o/r/issues/1', '', '/repo'), null);
    assert.equal(buildSourceLinkContext('https://github.com/o/r/issues/1', 'main', ''), null);
  });
});

describe('githubHeadingAnchor', () => {
  it('нижний регистр, убирает пунктуацию, пробелы → дефисы, кириллица и дефис сохранены', () => {
    assert.equal(
      githubHeadingAnchor('Почему не работает авторизация к LLM-эндпоинту?'),
      'почему-не-работает-авторизация-к-llm-эндпоинту',
    );
  });

  it('запятые и знаки убираются, цифры остаются', () => {
    assert.equal(
      githubHeadingAnchor('Что означает ответ 401, а что 403?'),
      'что-означает-ответ-401-а-что-403',
    );
  });
});

describe('linkifySources', () => {
  const context = { blobBaseUrl: 'https://github.com/o/r/blob/SHA', repoRoot: '/repo' };

  const answer = [
    'Ответ: текст.',
    'Источники:',
    '- authorization.md › Почему не работает авторизация к LLM-эндпоинту?',
    '- authorization.md › Что означает ответ 401, а что 403?',
    'Цитаты:',
    '- «authorization.md › не ссылка»',
  ].join('\n');

  it('пункты «Источников» становятся ссылками на файл+раздел, «Цитаты» не трогаются', () => {
    const out = linkifySources(answer, CHUNKS, context);
    assert.match(
      out,
      /- \[authorization\.md › Почему.*\]\(https:\/\/github\.com\/o\/r\/blob\/SHA\/support-bot\/faq\/authorization\.md#почему-не-работает-авторизация-к-llm-эндпоинту\)/,
    );
    assert.match(out, /authorization\.md#что-означает-ответ-401-а-что-403\)/);
    // строка в «Цитатах» осталась простым текстом (без markdown-ссылки)
    assert.match(out, /- «authorization\.md › не ссылка»/);
    assert.doesNotMatch(out, /не ссылка»\]\(/);
  });

  it('нет контекста → ответ без изменений', () => {
    assert.equal(linkifySources(answer, CHUNKS, null), answer);
  });

  it('нет чанков → ответ без изменений', () => {
    assert.equal(linkifySources(answer, [], context), answer);
  });

  it('источник совпал по файлу, но не по разделу → ссылка на файл без якоря', () => {
    const out = linkifySources(
      'Источники:\n- authorization.md (общий раздел без совпадения)',
      CHUNKS,
      context,
    );
    assert.match(out, /\/support-bot\/faq\/authorization\.md\)/);
    assert.doesNotMatch(out, /authorization\.md#/);
  });

  it('источник не сопоставлен с чанком → строка как есть', () => {
    const out = linkifySources('Источники:\n- unknown.md › раздел', CHUNKS, context);
    assert.match(out, /- unknown\.md › раздел$/);
    assert.doesNotMatch(out, /\]\(/);
  });

  it('пустой пункт-маркер в «Источниках» пропускается', () => {
    const out = linkifySources('Источники:\n- \nОтвет: конец', CHUNKS, context);
    assert.match(out, /Источники:\n- \nОтвет: конец/);
  });

  it('строка-пункт вне «Источников» (после «Ответ») не трогается', () => {
    const out = linkifySources(
      'Ответ:\n- authorization.md › Что означает ответ 401, а что 403?',
      CHUNKS,
      context,
    );
    assert.doesNotMatch(out, /\]\(/);
  });
});
